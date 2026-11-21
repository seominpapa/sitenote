package expo.modules.siteaudio

import android.net.Uri
import android.system.Os
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal object AudioFiles {
  private val id = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
  val waveName = Regex("audio-[A-Za-z0-9_-]{1,80}\\.wav")

  fun resolve(documents: File, uri: String, name: Regex): File {
    val url = Uri.parse(uri)
    require(url.scheme == "file" && url.authority.isNullOrEmpty() && url.query == null && url.fragment == null) {
      "앱 내부 기록 경로만 사용할 수 있습니다."
    }
    val target = File(requireNotNull(url.path))
    val parent = target.parentFile ?: throw IllegalArgumentException("올바른 기록 파일 경로가 아닙니다.")
    val parents = File("records", parent.name).path
    val expectedParent = File(documents.canonicalFile, parents)
    require(id.matches(parent.name) && name.matches(target.name) &&
      parent.absoluteFile.normalize() == File(documents.absoluteFile.normalize(), parents) &&
      parent.canonicalFile == expectedParent && target.canonicalFile == File(expectedParent, target.name)) {
      "올바른 기록 파일 경로가 아닙니다."
    }
    return target
  }

  fun writeText(documents: File, uri: String, text: String) {
    val target = resolve(documents, uri, Regex("(?:transcript|summary|source)\\.md"))
    val temp = File.createTempFile(".record-", ".tmp", target.parentFile)
    try {
      temp.outputStream().use {
        it.write(text.toByteArray(Charsets.UTF_8))
        it.fd.sync()
      }
      Os.rename(temp.path, target.path)
    } finally {
      temp.delete()
    }
  }
}

internal class WaveArchive(target: File) {
  private val file: RandomAccessFile
  private var bytes = 0L
  private var closed = false

  init {
    check(target.createNewFile()) { "이미 존재하는 음성 원본입니다." }
    file = RandomAccessFile(target, "rw")
    try {
      file.write(header(0))
    } catch (error: Exception) {
      file.close()
      target.delete()
      throw error
    }
  }

  @Synchronized fun append(pcm: ByteArray) {
    if (closed) return
    check(bytes + pcm.size <= 0xffffffffL - 36) { "음성 원본 파일의 크기 한도에 도달했습니다." }
    file.write(pcm)
    bytes += pcm.size
  }

  @Synchronized fun finish() {
    if (closed) return
    closed = true
    file.use {
      it.seek(0)
      it.write(header(bytes))
      it.fd.sync()
    }
  }

  private fun header(size: Long): ByteArray =
    ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt((size + 36).toInt())
      .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16)
      .putShort(1).putShort(1).putInt(24_000).putInt(48_000).putShort(2).putShort(16)
      .put("data".toByteArray(Charsets.US_ASCII)).putInt(size.toInt()).array()
}
