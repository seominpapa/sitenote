package expo.modules.siteaudio

import java.util.Locale

internal object NotePaths {
  private val noteId = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
  private val extensions = setOf("md", "markdown", "txt", "docx", "hwp", "hwpx")

  fun id(value: String): String = value.also {
    require(noteId.matches(it)) { "올바른 노트 ID가 아닙니다." }
  }

  fun name(value: String): String = value.also {
    val extension = it.substringAfterLast('.', "").lowercase(Locale.ROOT)
    require(it.length in 1..160 && it != "." && it != ".." &&
      '/' !in it && '\\' !in it && it.none(Char::isISOControl) && extension in extensions) {
      "지원되는 노트 파일 이름이 아닙니다."
    }
  }
}
