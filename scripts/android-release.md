# Android ARM64 출시 APK 다시 만들기

macOS 또는 Linux에서 Node.js 22.18 이상, Android용 JDK와 Android SDK를 준비합니다. SDK에는 Build Tools 37.0.0, Android SDK 플랫폼 37, NDK 27.1.12297006, CMake 3.22.1이 필요합니다. 이 프로젝트는 Gradle Wrapper를 사용하며 Android 네이티브 코드 컴파일에는 Java 17 도구 모음이 필요합니다. 현재 작업 환경에서는 JDK 26으로 Gradle을 실행하고, Gradle이 로컬에 보관한 Java 17로 Android 코드를 컴파일했습니다.

```sh
npm ci
export JAVA_HOME=/path/to/jdk
export ANDROID_HOME=/path/to/android/sdk
bash scripts/build-android-release.sh --output /tmp/Sitenote-Android-arm64.apk
```

Gradle, Java 도구 모음, 모든 빌드 의존성이 이미 로컬 캐시에 있으면 `--offline`을 추가할 수 있습니다. `--output`을 생략하면 검증 후 `dist/Sitenote-Android-arm64.apk`를 교체합니다. 생성된 `android/`가 없는 소스에서 시작하면 스크립트가 먼저 Expo Prebuild를 실행합니다. 기존 `android/`가 있는 상태에서 `app.json`의 네이티브 설정을 변경한 경우에는 빌드 전에 `node_modules/.bin/expo prebuild --platform android --no-install`로 반영하세요.

출시용 **기존** 키와 암호 파일은 기본으로 `.local-signing/sitenote.keystore`와 `.local-signing/password`를 사용합니다. 필요하면 각각 `SITENOTE_ANDROID_KEYSTORE`, `SITENOTE_ANDROID_PASSWORD_FILE`에 파일 경로를 지정합니다. 암호는 명령줄 값으로 넘기지 않습니다. 기존 설치 위에 업데이트하려면 동일한 앱 ID와 서명이 필요하므로 새 키를 임의로 만들지 마세요. 이 파일들을 소스나 APK와 함께 공유하지 않습니다.

스크립트는 JavaScript 번들을 APK에 새로 넣고, `com.sitenote.app`과 ARM64 전용 빌드 여부를 검사합니다. 기존 출시 인증서와 일치할 때만 최종 파일을 교체합니다. 생성된 파일의 SHA-256을 남기려면 `shasum -a 256 /tmp/Sitenote-Android-arm64.apk`를 실행합니다. 이는 동일 소스와 서명 키로 APK를 다시 만드는 절차이며, 두 빌드의 파일 바이트가 동일하다는 보장은 아닙니다.

출시 권한 목록은 `"$ANDROID_HOME/build-tools/37.0.0/aapt" dump permissions /tmp/Sitenote-Android-arm64.apk`로 확인합니다. `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`은 남아 있어야 하며, `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`는 없어야 합니다.

서명 검증은 기기 설치 및 음성 기능 검증을 대신하지 않습니다. 배포 전에는 기존 출시 APK가 설치된 ARM64 기기에서 업데이트가 되고 기존 기록이 보존되는지 확인합니다.
