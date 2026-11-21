package expo.modules.siteaudio

fun main() {
  check(NotePaths.id("note_2026-11" ) == "note_2026-11")
  check(NotePaths.name("transcript.md") == "transcript.md")
  check(NotePaths.name("report.hwpx") == "report.hwpx")
  check(NotePaths.name("minutes.markdown") == "minutes.markdown")
  check(runCatching { NotePaths.id("../note") }.isFailure)
  check(runCatching { NotePaths.name("../../secret.md") }.isFailure)
  check(NotePaths.name("report.pdf") == "report.pdf")
  check(runCatching { NotePaths.name("bad/name.md") }.isFailure)
  check(NotePaths.folder("20261121_현장 회의") == "20261121_현장 회의")
  check(NotePaths.candidate("20261121_현장 회의", 1) == "20261121_현장 회의")
  check(NotePaths.candidate("20261121_현장 회의", 2) == "20261121_현장 회의 (2)")
  check(runCatching { NotePaths.folder("20261121_../escape") }.isFailure)
  check(runCatching { NotePaths.folder("20261121_회.") }.isFailure)
  check(runCatching { NotePaths.folder("20261121_" + "회의".repeat(35)) }.isFailure)
}
