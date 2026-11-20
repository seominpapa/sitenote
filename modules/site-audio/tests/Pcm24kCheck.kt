package expo.modules.siteaudio

import java.nio.ByteBuffer
import java.nio.ByteOrder

private fun ByteArray.sample(index: Int) = ByteBuffer.wrap(this).order(ByteOrder.LITTLE_ENDIAN).getShort(index * 2).toInt()

fun main() {
  val direct = Pcm24k(24_000)
  val original = direct.convert(shortArrayOf(1, -32768, 32767), 3, muted = false)
  check((0..2).map(original::sample) == listOf(1, -32768, 32767))
  val split = Pcm24k(48_000)
  check(split.convert(shortArrayOf(10), 1, muted = false).isEmpty())
  check(split.convert(shortArrayOf(30), 1, muted = false).sample(0) == 20)
  val fractional = Pcm24k(44_100)
  val source = ShortArray(441) { 12345 }
  check(fractional.convert(source, 441, muted = false).let { it.size == 480 && it.sample(239) == 12345 })
  check(fractional.convert(source, 441, muted = true).let { it.size == 480 && it.all { b -> b == 0.toByte() } })
  println("Android PCM frame checks passed")
}
