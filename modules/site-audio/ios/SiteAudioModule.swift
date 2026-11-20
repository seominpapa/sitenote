import AVFoundation
import ExpoModulesCore
import UIKit

private let rate = 24_000.0
private let tail = 0.18
private var hostSeconds: Double { AVAudioTime.seconds(forHostTime: mach_absolute_time()) }

final class PlaybackGate {
  private let lock = NSLock()
  private var until = 0.0

  func set(_ until: Double) {
    lock.lock()
    self.until = until
    lock.unlock()
  }

  var suppresses: Bool {
    lock.lock()
    defer { lock.unlock() }
    return hostSeconds < until
  }
}

public final class SiteAudioModule: Module {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let gate = PlaybackGate()
  private let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
  private var archive: WaveArchive?
  private var running = false
  private var inputTap = false
  private var renderTap = false
  private var requestId: Double?
  private var generation = 0
  private var playbackGeneration = 0
  private var pendingPlayback = 0
  private var observers = [NSObjectProtocol]()

  public func definition() -> ModuleDefinition {
    Name("SiteAudio")
    Events("onAudio", "onPlayback", "onError", "onRender")

    AsyncFunction("startCapture") { (uri: String?, id: Double, bargeIn: Bool, promise: Promise) in
      self.requestCapture(uri, id, bargeIn, promise)
    }.runOnQueue(.main)
    AsyncFunction("cancelCaptureStart") { (id: Double) in
      if self.requestId == id { self.stop() }
    }.runOnQueue(.main)
    AsyncFunction("stopCapture") { self.stop() }.runOnQueue(.main)
    AsyncFunction("play") { (audio: String) in try self.enqueue(audio) }.runOnQueue(.main)
    AsyncFunction("stopPlayback") { self.stopOutput() }.runOnQueue(.main)
    AsyncFunction("writeTextAtomic") { (uri: String, text: String) in
      try SiteAudioFiles.writeText(uri, text, documents: self.documents)
    }
    OnDestroy {
      DispatchQueue.main.async { self.stop() }
    }
  }

  private var documents: URL { appContext?.config.documentDirectory ?? SiteAudioFiles.documents }

  private func requestCapture(_ uri: String?, _ id: Double, _ bargeIn: Bool, _ promise: Promise) {
    if running { promise.resolve(nil); return }
    requestId = id
    generation += 1
    let token = generation
    let completion: (Bool) -> Void = { granted in
      DispatchQueue.main.async {
        guard token == self.generation else {
          promise.reject("ERR_AUDIO_CANCELLED", "마이크 시작이 취소되었습니다.")
          return
        }
        guard granted else {
          promise.reject("ERR_MICROPHONE_PERMISSION", "마이크 권한을 허용해 주세요. 설정에서 다시 변경할 수 있습니다.")
          return
        }
        do {
          try self.start(uri, token, bargeIn)
          promise.resolve(nil)
        } catch {
          self.stop()
          promise.reject("ERR_CAPTURE_START", error.localizedDescription)
        }
      }
    }
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: completion)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(completion)
    }
  }

  private func start(_ uri: String?, _ token: Int, _ bargeIn: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setPreferredSampleRate(48_000)
    try session.setPreferredIOBufferDuration(0.020)
    try session.setActive(true)
    let input = engine.inputNode
    // The playback gate also works when the current audio route has no echo canceller.
    try? input.setVoiceProcessingEnabled(true)
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0,
          let pcm = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
          let converter = AVAudioConverter(from: format, to: pcm) else {
      throw SiteAudioFiles.error("지원되는 마이크 입력을 찾지 못했습니다.")
    }
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
    let detect = bargeIn && input.isVoiceProcessingEnabled
    if detect {
      player.installTap(onBus: 0, bufferSize: 1024, format: playbackFormat) { [weak self] buffer, time in
        self?.render(buffer,time,token)
      }
      renderTap = true
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
      self?.capture(buffer, using: converter, format: pcm, token: token,
        end: detect && time.isHostTimeValid
          ? AVAudioTime.seconds(forHostTime: time.hostTime) + Double(buffer.frameLength) / format.sampleRate : nil)
    }
    inputTap = true
    engine.prepare()
    try engine.start()
    running = true
    if let uri {
      do { archive = try WaveArchive(uri: uri, documents: documents) }
      catch { archiveError(error) }
    }
    observeInterruptions()
  }

  private func observeInterruptions() {
    let nc = NotificationCenter.default
    observers = [
      nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
        let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        if type == AVAudioSession.InterruptionType.began.rawValue { self?.interrupted() }
      },
      nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.interrupted()
      },
      nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
        if let self, !self.engine.isRunning { self.interrupted() }
      }
    ]
  }

  private func render(_ buffer: AVAudioPCMBuffer, _ time: AVAudioTime, _ token: Int) {
    guard gate.suppresses, time.isHostTimeValid, buffer.format.sampleRate == rate,
          let channel = buffer.floatChannelData?[0] else { return }
    var pcm = [Int16](repeating: 0, count: Int(buffer.frameLength))
    for index in pcm.indices {
      pcm[index] = Int16(clamping: Int(max(-1, min(1, channel[index])) * 32768)).littleEndian
    }
    let start = AVAudioTime.seconds(forHostTime: time.hostTime)
    let data = pcm.withUnsafeBytes { Data($0) }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.running, self.generation == token else { return }
      self.sendEvent("onRender", ["audio":data.base64EncodedString(),"start":start])
    }
  }

  private func capture(_ input: AVAudioPCMBuffer, using converter: AVAudioConverter, format: AVAudioFormat, token: Int, end: Double?) {
    let suppressed = gate.suppresses
    let count = AVAudioFrameCount(ceil(Double(input.frameLength) * rate / input.format.sampleRate)) + 8
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { return }
    var passed = false
    let status = converter.convert(to: output, error: nil) { _, inputStatus in
      inputStatus.pointee = passed ? .noDataNow : .haveData
      if passed { return nil }
      passed = true
      return input
    }
    guard status != .error, output.frameLength > 0, let samples = output.int16ChannelData?[0] else { return }
    let size = Int(output.frameLength) * MemoryLayout<Int16>.size
    let data = suppressed ? Data(count: size) : Data(bytes: samples, count: size)
    let candidate = suppressed && end != nil ? Data(bytes: samples, count: size) : nil
    DispatchQueue.main.async { [weak self] in
      guard let self, self.running, self.generation == token else { return }
      do { try self.archive?.append(data) }
      catch {
        try? self.archive?.finish()
        self.archive = nil
        self.archiveError(error)
      }
      var event: [String: Any] = ["audio": data.base64EncodedString(), "suppressed": suppressed]
      if let end { event["end"] = end }
      if let candidate { event["candidate"] = candidate.base64EncodedString() }
      self.sendEvent("onAudio", event)
    }
  }

  private func enqueue(_ audio: String) throws {
    guard running else { return }
    guard audio.utf8.count <= 256_000, let bytes = Data(base64Encoded: audio), !bytes.isEmpty,
          bytes.count.isMultiple(of: 2), pendingPlayback < 128,
          let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(bytes.count / 2)),
          let output = buffer.floatChannelData?[0] else {
      throw SiteAudioFiles.error("재생할 음성 형식이 올바르지 않거나 대기열이 가득 찼습니다.")
    }
    buffer.frameLength = buffer.frameCapacity
    bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      for i in 0..<Int(buffer.frameLength) {
        let sample = UInt16(raw[i * 2]) | (UInt16(raw[i * 2 + 1]) << 8)
        output[i] = Float(Int16(bitPattern: sample)) / 32_768
      }
    }
    let token = playbackGeneration
    pendingPlayback += 1
    gate.set(.infinity)
    if pendingPlayback == 1 { sendEvent("onPlayback", ["active": true]) }
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, token == self.playbackGeneration else { return }
        self.pendingPlayback -= 1
        if self.pendingPlayback == 0 { self.outputEnded() }
      }
    }
    if !player.isPlaying { player.play() }
  }

  private func outputEnded() {
    let now = hostSeconds
    gate.set(now + tail)
    sendEvent("onRender", ["end":now])
    sendEvent("onPlayback", ["active": false])
  }

  private func stopOutput() {
    playbackGeneration += 1
    let wasPlaying = pendingPlayback > 0
    pendingPlayback = 0
    player.stop()
    if wasPlaying { outputEnded() }
  }

  private func stop() {
    generation += 1
    requestId = nil
    running = false
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    stopOutput()
    if inputTap {
      engine.inputNode.removeTap(onBus: 0)
      inputTap = false
    }
    if renderTap {
      player.removeTap(onBus: 0)
      renderTap = false
    }
    engine.stop()
    if engine.attachedNodes.contains(player) { engine.detach(player) }
    do { try archive?.finish() }
    catch { archiveError(error) }
    archive = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func interrupted() {
    guard running else { return }
    stop()
    sendEvent("onError", ["message": "마이크 사용이 중단되었습니다. 앱에서 다시 시작해 주세요."])
  }

  private func archiveError(_ error: Error) {
    sendEvent("onError", ["message": "음성 원본을 저장하지 못했습니다: \(error.localizedDescription)", "scope": "archive"])
  }
}
