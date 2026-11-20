package expo.modules.siteaudio

import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.jni.ArrayBuffer

internal class VoicePreview {
  private var session: Pair<MediaPlayer, Promise>? = null

  fun play(wave: ArrayBuffer, promise: Promise) {
    stop()
    require(wave.size() in 45..384_044) { "미리듣기 음성의 크기가 올바르지 않습니다." }
    val bytes = ByteArray(wave.size())
    wave.toDirectBuffer().get(bytes)
    val player = MediaPlayer()
    session = player to promise
    try {
      player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      player.setDataSource(object : MediaDataSource() {
        override fun getSize(): Long = bytes.size.toLong()
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
          if (size == 0) return 0
          if (position !in 0 until bytes.size.toLong()) return -1
          val start = position.toInt()
          val count = minOf(bytes.size - start, size)
          bytes.copyInto(buffer, offset, start, start + count)
          return count
        }
        override fun close() = Unit
      })
      player.setOnPreparedListener {
        if (session?.first == it) {
          try { it.start() }
          catch (error: Exception) { stop(error) }
        }
      }
      player.setOnCompletionListener { if (session?.first == it) stop() }
      player.setOnErrorListener { failed, _, _ ->
        if (session?.first == failed) stop(IllegalStateException("미리듣기 재생 실패"))
        true
      }
      player.prepareAsync()
    } catch (error: Exception) {
      stop(error)
    }
  }

  fun stop(error: Exception? = null) {
    val (player, promise) = session ?: return
    session = null
    player.release()
    if (error == null) promise.resolve()
    else promise.reject("ERR_AUDIO_PREVIEW", "목소리를 미리 재생하지 못했습니다.", error)
  }
}
