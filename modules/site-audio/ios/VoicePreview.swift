import AVFoundation
import ExpoModulesCore

final class VoicePreview: NSObject, AVAudioPlayerDelegate {
  private var active: (AVAudioPlayer, Promise)?

  func play(_ wave: ExpoModulesCore.ArrayBuffer, _ promise: Promise) {
    stop()
    guard (45...384_044).contains(wave.byteLength) else {
      promise.reject("ERR_AUDIO_PREVIEW", "미리듣기 음성의 크기가 올바르지 않습니다.")
      return
    }
    do {
      let data = wave.withUnsafeBytes { Data($0) }
      let player = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.wav.rawValue)
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
      try session.setActive(true)
      active = (player, promise)
      player.delegate = self
      if !player.play() { stop(success: false) }
    } catch {
      promise.reject("ERR_AUDIO_PREVIEW", "목소리를 미리 재생하지 못했습니다.")
    }
  }

  func stop(success: Bool = true) {
    guard let (player, promise) = active else { return }
    active = nil
    player.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    if success { promise.resolve() }
    else { promise.reject("ERR_AUDIO_PREVIEW", "목소리를 미리 재생하지 못했습니다.") }
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    if active?.0 === player { stop(success: flag) }
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    if active?.0 === player { stop(success: false) }
  }
}
