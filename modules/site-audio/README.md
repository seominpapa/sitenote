# SiteAudio

The Expo development build includes this local module on iOS and Android. It opens one foreground microphone and emits base64 mono PCM16 at 24 kHz. AI playback and its 180 ms tail are gated. During personal and meeting Q&A, enabled device echo cancellation plus a usable hardware clock for the speaker are required before the app checks for distinct sustained speech. A confirmed opening stops playback and forwards its buffered opening frames. If either feature is unavailable, the stream stays muted during AI output and the user can use the stop button. Followup keeps the hard playback gate.

An optional recording is written to the configured app document folder as `records/<id>/audio-<part>.wav`. It remains muted throughout the playback gate, even when confirmed opening speech is forwarded for transcription. It does not include synthesized AI output. WAV headers are finalized when capture stops; a forced kill can leave the last WAV part unfinalized. Markdown replacements in the private records directory are atomic independently of the optional audio capture.

To check the Swift file writer on macOS and the Android PCM converter with a Kotlin JVM installation, run from the project root:

```sh
swiftc -module-cache-path /tmp/sitenote-swift-cache modules/site-audio/ios/AudioFiles.swift modules/site-audio/tests/main.swift -o /tmp/sitenote-audio-tests
/tmp/sitenote-audio-tests
kotlinc modules/site-audio/android/src/main/java/expo/modules/siteaudio/Pcm24k.kt modules/site-audio/tests/Pcm24kCheck.kt -include-runtime -d /tmp/sitenote-pcm.jar
java -jar /tmp/sitenote-pcm.jar
node --experimental-strip-types --test modules/site-audio/tests/input.test.ts
```

On each physical platform, test microphone denial and reenable, room playback at several volumes, playback interruption, Bluetooth route change, background and foreground transitions, and opening the opt-in WAV after stopping.
