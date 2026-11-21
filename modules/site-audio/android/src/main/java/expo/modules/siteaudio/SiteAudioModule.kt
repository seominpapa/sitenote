package expo.modules.siteaudio

import android.Manifest
import android.content.Context
import android.content.Intent
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.jni.ArrayBuffer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

class SiteAudioModule : Module() {
  private class Capture(val id: Double, val record: AudioRecord, val echo: AcousticEchoCanceler?,
                        val detect: Boolean, var archive: WaveArchive?) {
    var reader: Thread? = null
  }

  private val context: Context get() = requireNotNull(appContext.reactContext)
  private val audioLock = Any()
  private var audioManager: AudioManager? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var previousSpeaker = false
  private var speakerOverride = false
  @Volatile private var capture: Capture? = null
  @Volatile private var suppressUntil = 0L
  @Volatile private var clockedSpeaker = false
  private val outputThread = HandlerThread("SiteAudioPlayback").apply { start() }
  private val outputHandler = Handler(outputThread.looper)
  private val outputQueue = ArrayDeque<ShortArray>()
  private var track: AudioTrack? = null
  private var index = 0
  private var framesWritten = 0L
  private var lastHead = 0L
  private var lastProgress = 0L
  private var playing = false
  private var audibleClock: Double? = null
  private val preview = VoicePreview()
  private var folderPromise: Promise? = null
  private var documentPromise: Promise? = null
  private val pendingRender = ArrayDeque<Pair<Long, ShortArray>>()
  private val pump = Runnable {
    synchronized(audioLock) {
      try { pumpOutput() }
      catch (_: IllegalStateException) { outputFailed() }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("SiteAudio")
    Events("onAudio", "onPlayback", "onError", "onRender")
    AsyncFunction("startCapture") { uri: String?, id: Double, bargeIn: Boolean ->
      synchronized(audioLock) { start(uri,id,bargeIn) }
    }
    AsyncFunction("cancelCaptureStart") { id: Double -> synchronized(audioLock) { if (capture?.id == id) stop() } }
    AsyncFunction("stopCapture") { synchronized(audioLock) { stop() } }
    AsyncFunction("play") { audio: String -> synchronized(audioLock) { enqueue(audio) } }
    AsyncFunction("stopPlayback") { synchronized(audioLock) { stopOutput() } }
    AsyncFunction("playPreview") { wave: ArrayBuffer, promise: Promise -> preview.play(wave, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopPreview") { preview.stop() }.runOnQueue(Queues.MAIN)
    AsyncFunction("writeTextAtomic") { uri: String, text: String ->
      AudioFiles.writeText(appContext.persistentFilesDirectory, uri, text)
    }
    AsyncFunction("pickNoteFolder") { promise: Promise -> pickFolder(promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("pickNoteDocument") { promise: Promise -> pickDocument(promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("writeNoteFile") { folderUri: String, id: String, name: String, localPath: String, archive: Boolean ->
      mapOf("uri" to NoteDocuments.write(context, Uri.parse(folderUri), id, name, localPath, archive).toString())
    }
    AsyncFunction("openNoteFile") { folderUri: String, id: String, name: String, archive: Boolean ->
      NoteDocuments.open(context, Uri.parse(folderUri), id, name, archive)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("deleteNoteFiles") { folderUri: String, id: String ->
      NoteDocuments.deleteGenerated(context, Uri.parse(folderUri), id)
    }
    OnActivityResult { _, payload ->
      when (payload.requestCode) {
        PICK_FOLDER -> finishFolder(payload.resultCode, payload.data)
        PICK_DOCUMENT -> finishDocument(payload.resultCode, payload.data)
      }
    }
    OnActivityEntersBackground {
      preview.stop()
      synchronized(audioLock) {
        if (capture != null) {
          stop()
          onError("마이크 사용이 중단되었습니다. 앱에서 다시 시작해 주세요.")
        }
      }
    }
    OnDestroy {
      Handler(android.os.Looper.getMainLooper()).post { preview.stop() }
      synchronized(audioLock) { stop() }
      outputThread.quitSafely()
    }
  }

  private fun pickFolder(promise: Promise) {
    check(folderPromise == null) { "폴더 선택 창이 이미 열려 있습니다." }
    val activity = requireNotNull(appContext.currentActivity) { "폴더 선택 창을 열 수 없습니다." }
    folderPromise = promise
    try {
      activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
      ).putExtra(Intent.EXTRA_LOCAL_ONLY, true), PICK_FOLDER)
    } catch (error: Exception) {
      folderPromise = null
      throw error
    }
  }

  private fun pickDocument(promise: Promise) {
    check(documentPromise == null) { "파일 선택 창이 이미 열려 있습니다." }
    val activity = requireNotNull(appContext.currentActivity) { "파일 선택 창을 열 수 없습니다." }
    documentPromise = promise
    try {
      activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
        .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_LOCAL_ONLY, true)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), PICK_DOCUMENT)
    } catch (error: Exception) {
      documentPromise = null
      throw error
    }
  }

  private fun finishFolder(result: Int, data: Intent?) {
    val promise = folderPromise ?: return
    folderPromise = null
    if (result != Activity.RESULT_OK || data?.data == null) { promise.resolve(null); return }
    try {
      val uri = requireNotNull(data.data)
      val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      require(flags == (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) {
        "읽기와 쓰기가 가능한 폴더를 선택해 주세요."
      }
      context.contentResolver.takePersistableUriPermission(uri, flags)
      promise.resolve(mapOf("uri" to uri.toString(), "label" to NoteDocuments.label(context.contentResolver, uri)))
    } catch (error: Exception) {
      promise.reject("ERR_NOTE_FOLDER", error.message ?: "폴더 권한을 저장하지 못했습니다.", error)
    }
  }

  private fun finishDocument(result: Int, data: Intent?) {
    val promise = documentPromise ?: return
    documentPromise = null
    if (result != Activity.RESULT_OK || data?.data == null) { promise.resolve(null); return }
    val uri = requireNotNull(data.data)
    thread(name = "SiteAudioImport", isDaemon = true) {
      try { promise.resolve(NoteDocuments.import(context.contentResolver, context.cacheDir, uri)) }
      catch (error: Exception) {
        promise.reject("ERR_NOTE_IMPORT", error.message ?: "파일을 가져오지 못했습니다.", error)
      }
    }
  }

  private companion object {
    const val PICK_FOLDER = 7091
    const val PICK_DOCUMENT = 7092
  }

  private fun start(uri: String?, id: Double, bargeIn: Boolean) {
    if (capture != null) return
    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "마이크 권한을 허용해 주세요. 설정에서 다시 변경할 수 있습니다."
    }
    var record: AudioRecord? = null
    var echo: AcousticEchoCanceler? = null
    try {
      useCommunicationRoute()
      val input = openInput()
      record = input
      if (AcousticEchoCanceler.isAvailable()) {
        echo = runCatching { AcousticEchoCanceler.create(input.audioSessionId) }.getOrNull()
        runCatching { echo?.enabled = true }
      }
      input.startRecording()
      check(input.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "마이크를 시작하지 못했습니다." }
      val archive = if (uri == null) null else try {
        WaveArchive(AudioFiles.resolve(appContext.persistentFilesDirectory, uri, AudioFiles.waveName))
      } catch (error: Exception) {
        archiveError(error)
        null
      }
      val aecEnabled = runCatching { echo?.enabled == true }.getOrDefault(false)
      val state = Capture(id,input,echo,bargeIn && aecEnabled && Build.VERSION.SDK_INT >= 24,archive)
      capture = state
      state.reader = thread(name = "SiteAudioCapture", isDaemon = true) { readInput(state) }
    } catch (error: Exception) {
      capture = null
      runCatching { record?.stop() }
      record?.release()
      echo?.release()
      restoreRoute()
      throw error
    }
  }

  private fun openInput(): AudioRecord {
    for (source in listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.MIC)) {
      for (rate in listOf(48_000, RATE, 44_100)) {
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) continue
        val candidate = runCatching {
          AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, rate / 5))
        }.getOrNull() ?: continue
        if (candidate.state == AudioRecord.STATE_INITIALIZED) return candidate
        candidate.release()
      }
    }
    throw IllegalStateException("지원되는 마이크 입력을 찾지 못했습니다.")
  }

  private fun readInput(state: Capture) {
    val buffer = ShortArray(state.record.sampleRate / 50)
    val converter = Pcm24k(state.record.sampleRate)
    val timestamp = AudioTimestamp()
    var framesRead = 0L
    while (capture === state) {
      val before = suppresses()
      val count = try { state.record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING) }
      catch (_: IllegalStateException) { AudioRecord.ERROR_INVALID_OPERATION }
      if (capture !== state) return
      if (count < 0) {
        outputHandler.post {
          synchronized(audioLock) {
            if (capture === state) {
              stop()
              onError("마이크 입력을 읽지 못했습니다. 다시 시작해 주세요.")
            }
          }
        }
        return
      }
      if (count == 0) continue
      framesRead += count
      val muted = before || suppresses()
      val end = inputEnd(state,timestamp,framesRead)
      val candidate = muted && end != null && clockedSpeaker
      val pcm = converter.convert(buffer,count,muted && !candidate)
      if (pcm.isEmpty()) continue
      val safe = if (candidate) ByteArray(pcm.size) else pcm
      try { state.archive?.append(safe) }
      catch (error: Exception) {
        runCatching { state.archive?.finish() }
        state.archive = null
        archiveError(error)
      }
      if (capture === state) sendEvent("onAudio", buildMap<String,Any> {
        put("audio",Base64.encodeToString(safe,Base64.NO_WRAP))
        put("suppressed",muted)
        if (end != null) put("end",end)
        if (candidate) put("candidate",Base64.encodeToString(pcm,Base64.NO_WRAP))
      })
    }
  }

  private fun inputEnd(state: Capture, timestamp: AudioTimestamp, framesRead: Long): Double? {
    if (!state.detect || Build.VERSION.SDK_INT < 24 ||
        state.record.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC) != AudioRecord.SUCCESS) return null
    val end = timestamp.nanoTime / 1e9 + (framesRead - timestamp.framePosition).toDouble() / state.record.sampleRate
    return end.takeIf { System.nanoTime() / 1e9 - it in -0.02..0.24 }
  }

  private fun stop() {
    stopOutput()
    val state = capture
    capture = null
    if (state != null) {
      runCatching { state.record.stop() }
      if (state.reader !== Thread.currentThread()) state.reader?.join(250)
      state.record.release()
      state.echo?.release()
      try { state.archive?.finish() }
      catch (error: Exception) { archiveError(error) }
    }
    track?.release()
    track = null
    restoreRoute()
  }

  private fun enqueue(audio: String) {
    if (capture == null) return
    require(audio.length <= 256_000 && outputQueue.size < 128) { "음성 재생 대기열이 가득 찼습니다." }
    val bytes = Base64.decode(audio, Base64.DEFAULT)
    require(bytes.isNotEmpty() && bytes.size % 2 == 0) { "재생할 음성 형식이 올바르지 않습니다." }
    val samples = ShortArray(bytes.size / 2)
    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples)
    if (track == null) track = createTrack()
    if (!playing) {
      suppressUntil = Long.MAX_VALUE
      clockedSpeaker = false
      audibleClock = null
      try { track?.play() }
      catch (error: Exception) {
        suppressUntil = 0
        throw error
      }
      playing = true
      lastProgress = SystemClock.elapsedRealtime()
      sendEvent("onPlayback", mapOf("active" to true))
    }
    outputQueue.addLast(samples)
    outputHandler.removeCallbacks(pump)
    outputHandler.post(pump)
  }

  private fun pumpOutput() {
    val player = track ?: return
    val current = outputQueue.firstOrNull()
    if (current != null) {
      val written = player.write(current, index, current.size - index, AudioTrack.WRITE_NON_BLOCKING)
      if (written < 0) {
        outputFailed()
        return
      }
      if (written > 0 && capture?.detect == true) renderWritten(framesWritten,current.copyOfRange(index,index+written))
      index += written
      framesWritten += written
      if (written > 0) lastProgress = SystemClock.elapsedRealtime()
      if (index == current.size) {
        outputQueue.removeFirst()
        index = 0
      }
    }
    val head = player.playbackHeadPosition.toLong() and 0xffffffffL
    if (capture?.detect == true) updateSpeakerClock(player)
    if (head != lastHead) lastProgress = SystemClock.elapsedRealtime()
    lastHead = head
    when {
      outputQueue.isEmpty() && head >= framesWritten -> stopOutput()
      SystemClock.elapsedRealtime() - lastProgress > 3_000 -> outputFailed()
      else -> outputHandler.postDelayed(pump, 10L)
    }
  }

  private fun renderWritten(start: Long, samples: ShortArray) {
    val clock = audibleClock
    if (clock != null) {
      val bytes = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
      bytes.asShortBuffer().put(samples)
      emitRender(start,bytes.array(),clock)
    } else {
      pendingRender.addLast(start to samples)
      if (pendingRender.size > 48) pendingRender.removeFirst()
    }
  }

  private fun emitRender(start: Long, bytes: ByteArray, clock: Double) {
    sendEvent("onRender",mapOf("audio" to Base64.encodeToString(bytes,Base64.NO_WRAP),"start" to clock + start.toDouble()/RATE))
  }

  private fun updateSpeakerClock(player: AudioTrack) {
    if (audibleClock != null) return
    val timestamp = AudioTimestamp()
    if (!player.getTimestamp(timestamp) || timestamp.framePosition !in 0..framesWritten ||
        System.nanoTime() / 1e9 - timestamp.nanoTime / 1e9 !in -0.02..0.24) return
    audibleClock = timestamp.nanoTime / 1e9 - timestamp.framePosition.toDouble()/RATE
    while (pendingRender.isNotEmpty()) {
      val (start,samples) = pendingRender.removeFirst()
      renderWritten(start,samples)
    }
    clockedSpeaker = true
  }

  private fun outputFailed() {
    stopOutput()
    track?.release()
    track = null
    sendEvent("onError", mapOf("message" to "AI 음성 재생이 중단되었습니다.", "scope" to "playback"))
  }

  private fun stopOutput() {
    outputHandler.removeCallbacks(pump)
    outputQueue.clear()
    index = 0
    framesWritten = 0
    lastHead = 0
    pendingRender.clear()
    audibleClock = null
    if (playing) {
      playing = false
      suppressUntil = SystemClock.elapsedRealtime() + 180
      runCatching { track?.pause() }
      runCatching { track?.flush() }
      sendEvent("onRender",mapOf("end" to System.nanoTime()/1e9))
      sendEvent("onPlayback", mapOf("active" to false))
    }
  }

  private fun createTrack(): AudioTrack {
    val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    check(min > 0) { "지원되는 AI 음성 출력을 찾지 못했습니다." }
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    val format = AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
    val output = AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(format)
      .setBufferSizeInBytes(maxOf(min, RATE / 5)).setTransferMode(AudioTrack.MODE_STREAM).build()
    if (output.state == AudioTrack.STATE_INITIALIZED) {
      if (Build.VERSION.SDK_INT >= 31) output.setStartThresholdInFrames(minOf(output.bufferSizeInFrames, RATE / 50))
      return output
    }
    output.release()
    throw IllegalStateException("지원되는 AI 음성 출력을 찾지 못했습니다.")
  }

  @Suppress("DEPRECATION")
  private fun useCommunicationRoute() {
    val manager = requireNotNull(context.getSystemService(AudioManager::class.java))
    audioManager = manager
    previousMode = manager.mode
    previousSpeaker = manager.isSpeakerphoneOn
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= 31) {
      if (manager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
        val speaker = manager.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        speakerOverride = speaker != null && manager.setCommunicationDevice(speaker)
      }
    } else if (manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none {
        it.type in listOf(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET,
          AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_USB_HEADSET)
      }) {
      manager.isSpeakerphoneOn = true
      speakerOverride = true
    }
  }

  @Suppress("DEPRECATION")
  private fun restoreRoute() {
    val manager = audioManager ?: return
    if (speakerOverride) {
      if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice()
      else manager.isSpeakerphoneOn = previousSpeaker
    }
    manager.mode = previousMode
    audioManager = null
    speakerOverride = false
  }

  private fun suppresses() = SystemClock.elapsedRealtime() < suppressUntil

  private fun onError(message: String) = sendEvent("onError", mapOf("message" to message))

  private fun archiveError(error: Exception) = sendEvent("onError",
    mapOf("message" to "음성 원본을 저장하지 못했습니다: ${error.localizedMessage}", "scope" to "archive"))
}
