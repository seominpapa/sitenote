package expo.modules.siteaudio

fun main() {
  check(NotePaths.id("note_2026-11" ) == "note_2026-11")
  check(NotePaths.name("transcript.md") == "transcript.md")
  check(NotePaths.name("report.hwpx") == "report.hwpx")
  check(NotePaths.name("minutes.markdown") == "minutes.markdown")
  check(runCatching { NotePaths.id("../note") }.isFailure)
  check(runCatching { NotePaths.name("../../secret.md") }.isFailure)
  check(runCatching { NotePaths.name("report.pdf") }.isFailure)
  check(runCatching { NotePaths.name("bad/name.md") }.isFailure)
}
