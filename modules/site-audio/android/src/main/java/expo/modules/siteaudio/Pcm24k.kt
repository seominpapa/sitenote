package expo.modules.siteaudio

import java.nio.ByteBuffer
import java.nio.ByteOrder

internal const val RATE = 24_000

internal class Pcm24k(private val sampleRate: Int) {
  private var accumulated = 0
  private var energy = 0

  fun convert(samples: ShortArray, count: Int, muted: Boolean): ByteArray {
    val result = ByteBuffer.allocate(((count * RATE + accumulated) / sampleRate) * 2)
      .order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until count) {
      val sample = if (muted) 0 else samples[i].toInt()
      val toBoundary = sampleRate - accumulated
      if (toBoundary > RATE) {
        energy += sample * RATE
        accumulated += RATE
      } else {
        energy += sample * toBoundary
        result.putShort(if (muted) 0 else (energy / sampleRate).toShort())
        accumulated = RATE - toBoundary
        energy = sample * accumulated
      }
    }
    return result.array()
  }
}
