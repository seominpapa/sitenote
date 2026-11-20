# Sitenote

개인 음성 대화와 대면 회의를 기록하고 이어서 물을 수 있는 앱입니다. Mac·Windows에서는 데스크톱 앱이나 로컬 웹앱으로, iOS·Android에서는 네이티브 앱으로 사용합니다. Expo Go에서는 네이티브 오디오 모듈을 실행할 수 없습니다.

## 다운로드

처음 사용한다면 Mac은 **DMG**, Windows는 **EXE**를 선택하세요. 두 파일에는 실행에 필요한 프로그램과 로컬 서버가 포함되어 있으며 Node.js를 따로 설치하지 않아도 됩니다.

| 기기 · 방식 | 다운로드 | 실행 |
| --- | --- | --- |
| Mac · Apple Silicon(M 시리즈) | [Sitenote-macOS-arm64.dmg](https://github.com/seominpapa/sitenote/releases/latest/download/Sitenote-macOS-arm64.dmg) | DMG를 열어 Sitenote를 응용 프로그램 폴더로 옮긴 뒤 실행 |
| Mac · Intel | [Sitenote-macOS-x64.dmg](https://github.com/seominpapa/sitenote/releases/latest/download/Sitenote-macOS-x64.dmg) | Intel Mac에서 DMG를 열어 Sitenote를 응용 프로그램 폴더로 옮긴 뒤 실행 |
| Windows · 64비트 Intel/AMD | [Sitenote-Windows-x64.exe](https://github.com/seominpapa/sitenote/releases/latest/download/Sitenote-Windows-x64.exe) | 다운로드한 휴대용 EXE를 더블클릭 |
| Mac·Windows · 브라우저로 사용 | [Sitenote-Desktop.zip](https://github.com/seominpapa/sitenote/releases/latest/download/Sitenote-Desktop.zip) | 압축을 전부 풀고 Mac은 `Sitenote.command`, Windows는 `Sitenote.cmd` 실행 |
| Android · ARM64 | [Sitenote-Android-arm64.apk](https://github.com/seominpapa/sitenote/releases/latest/download/Sitenote-Android-arm64.apk) | 휴대폰에서 APK를 열어 설치. 음성 기능에는 아래의 HTTPS 서버 설정 필요 |

[버전별 배포 파일](https://github.com/seominpapa/sitenote/releases) · [SHA-256 체크섬](https://github.com/seominpapa/sitenote/releases/latest/download/SHA256SUMS.txt)

## 데스크톱 앱 첫 실행

Mac용 DMG는 Apple 공증을 받지 않았고, Windows용 EXE에는 게시자 서명이 없습니다. 아래 절차는 이 저장소의 [릴리스](https://github.com/seominpapa/sitenote/releases)에서 받은 파일이 같은 릴리스의 SHA-256 체크섬과 일치하고, 기기 관리 정책에서 실행을 허용할 때만 사용하세요.

### Mac — DMG

1. DMG를 열고 `Sitenote.app`을 **응용 프로그램**으로 드래그하세요. 복사가 끝나면 DMG를 추출하고 **응용 프로그램 → Sitenote**를 엽니다.
2. macOS가 개발자를 확인할 수 없다며 앱을 막으면 경고를 닫고 **시스템 설정 → 개인정보 보호 및 보안 → 보안 → 그래도 열기**를 선택합니다. 다시 확인 창이 뜨면 앱 이름을 확인하고 열기를 승인합니다.
3. **그래도 열기**가 표시되지 않거나 macOS가 파일 손상·악성코드를 경고하면 실행을 중단하세요. 회사나 학교 기기에서 정책으로 막힌 경우에는 담당자에게 문의하세요.

### Windows — 포터블 EXE

1. `Sitenote-Windows-x64.exe`를 더블클릭합니다. 설치 마법사 없이 앱이 시작됩니다.
2. SmartScreen에 **Windows의 PC 보호**가 표시되면 **추가 정보 → 실행**을 선택합니다. **실행** 버튼이 없거나 Windows 보안이 위협을 감지했다면 진행하지 마세요. 회사나 학교 기기에서는 담당자에게 문의하세요.

운영체제의 보호 기능을 끌 필요는 없습니다. 데스크톱 앱을 열기 어렵다면 아래 웹앱 ZIP을 사용할 수 있습니다.

앱이 열리면 **설정**에서 API 키를 등록하고, 녹음할 때 마이크 사용을 허용하세요. 원문과 요약은 로컬 PC에 저장됩니다. 데스크톱 앱과 웹앱은 기록을 따로 보관하므로 기존 웹앱 노트는 원래 브라우저와 주소에서 열어야 합니다.

### 데스크톱 업데이트

v0.1.1부터 앱이 시작할 때 GitHub의 공개 릴리스를 확인합니다. 새 버전이 있으면 첫 화면에서 **업데이트 다운로드** 또는 **나중에**를 선택할 수 있습니다. **설정 → 앱 업데이트 → 업데이트 확인**에서도 다시 확인할 수 있습니다.

다운로드와 체크섬 확인이 끝나면, 진행 중인 작업을 저장하고 앱을 닫은 뒤 새 버전으로 교체합니다. Mac은 **DMG 열기**로 설치 이미지를 열고 새 앱을 응용 프로그램 폴더로 복사합니다. Windows는 **EXE 파일 위치 열기**로 받은 파일을 찾은 뒤 원하는 위치로 옮겨 실행합니다. 노트와 설정은 앱 파일과 별도로 보관됩니다. v0.1.0 사용자는 위 표에서 파일을 한 번 직접 내려받으세요.

## Mac·Windows에서 웹앱 실행

1. **Node.js 22.18 이상**을 한 번 설치합니다. 다른 컴퓨터로 옮길 때는 `Sitenote-Desktop.zip`을 받아 압축을 전부 풀고, 그 폴더 안에서 실행합니다. ZIP에는 서버 의존성이 포함되어 있습니다. 전사·AI 기능 사용 시에는 인터넷 연결이 필요합니다.
2. Mac은 Finder에서 **Sitenote.command**, Windows는 파일 탐색기에서 **Sitenote.cmd**를 더블클릭합니다. 실행 파일이 서버를 켜고 기본 브라우저에서 `http://127.0.0.1:8787`을 엽니다. 브라우저가 자동으로 열리지 않으면 Chrome 주소창에 이 주소를 넣습니다.
3. 종료하려면 실행 창에서 **Ctrl+C**를 누릅니다. 브라우저 탭을 닫고 다시 열 수 있지만, 주소가 서버를 새로 켜주지는 않습니다. 업데이트 전에는 진행 중인 녹음을 저장하고 기존 실행 창을 종료한 뒤 새 버전의 실행기를 여세요.

**설정**에서 전사용 **Soniox API 키**와 필요에 따라 **OpenAI API 키**(AI 음성 답변, 요약)를 입력하고 **API 키 저장**을 누릅니다. 한 키만 바꿀 때는 다른 칸을 비워 둡니다. 실행 파일을 다시 열 필요는 없습니다. 저장한 키는 같은 노트북의 서버에 보관되며 브라우저 화면에 다시 표시되지 않습니다. **키 저장됨**은 서버에 키가 있다는 뜻으로, 제공자 연결과 모델 권한은 해당 기능을 사용할 때 확인됩니다. 녹음을 시작할 때 브라우저의 마이크 접근을 허용합니다. 음성·요약 요청은 해당 서비스가 처리하므로 인터넷 연결이 필요합니다.

이 실행 모드는 같은 노트북에서만 접속할 수 있습니다. 원문과 요약은 브라우저 프로필에 저장되므로 같은 주소와 프로필로 다시 열어야 기존 노트가 보입니다. 모바일 앱 데이터와 자동으로 동기화되지 않습니다. 다른 브라우저로 바꾸거나 브라우저 데이터를 지우기 전에는 Markdown으로 내보내세요.

개인 대화와 회의 모두 시작 전에 제목을 입력하고, 필요하면 프로젝트명을 추가합니다. 녹음을 시작하면 Soniox 전사만 켜집니다. **AI에게 질문**을 누르고 **지금 질문하세요**가 표시되면 말하세요. 발화가 끝나 Soniox가 확정한 질문 문장을 GPT-Live-1.1에 보내 음성 답변을 받습니다. 노트북 웹앱에서는 AI가 답변하는 동안 말을 시작해도 됩니다. 사용자의 말이 감지되면 답변 재생을 멈추고 새 말을 전사합니다. 직접 멈추려면 **AI 음성 중지**, 전사만 계속하려면 **AI 질문 닫기**를 누르세요.

**설정 → AI 목소리**에서 목소리를 고르고 **짧게 들어보기**로 확인할 수 있습니다. 선택한 목소리는 다음 녹음이나 보충질문부터 적용됩니다. 들어보기에는 고정된 안내 문장만 사용합니다.

녹음 중 AI에게 질문하면 과거 노트에서 관련 있는 사람의 발언을 최대 두 개 찾습니다. “지난 회의에서 뭐라고 했지?”처럼 물으면 참고 범위 안에서 가장 최근 회의를 찾습니다. 회의에 프로젝트를 지정하면 같은 프로젝트의 기록만 참고합니다. **이 답변의 과거 원문**에서 답변이 직접 인용한 문장과 답변을 위해 제공한 자료를 구분합니다. 의역한 내용은 직접 인용으로 표시하지 않습니다. 녹음 중에는 원문을 눌러 읽고, 저장 후에는 각 답변 아래에서 원래 노트의 발언으로 이동할 수 있습니다.

새 개인 기록은 기본으로 회의 중 AI 답변의 참고 대상입니다. 제외하려면 해당 노트의 **기록 설정**에서 **회의에서 이 개인 기록 참고하지 않음**을 체크하고 저장하세요. 이미 저장된 개인 기록의 설정은 유지됩니다.

회의가 끝나면 마이크를 준비하고 보충 질문 안내를 읽습니다. 안내가 끝나면 **“예”**, **“아니요”** 또는 **“아니오”**라고 말하거나 버튼으로 선택할 수 있습니다. 안내 중 마이크 음성은 전송하지 않습니다. 안내 뒤에 받은 선택 음성만 Soniox에서 처리하고 회의록에는 저장하지 않습니다. 수락하면 회의 요약을 기다리지 않고 보충 질문을 시작합니다. GPT가 질문하고 Soniox가 참가자 답변을 화자별로 전사합니다. 질문이 끝나면 바로 답변할 수 있습니다. AI는 답변을 판단해 다음 질문을 하거나 필요한 점을 되묻습니다. 질문과 답변은 같은 노트의 별도 구역에 저장됩니다. 화자 번호는 녹음 연결마다 별도로 부여됩니다.

최근 노트는 기본 **날짜순**으로 한 페이지에 10개씩 표시됩니다. 오른쪽 체크박스로 기록을 골라 **선택 삭제**를 누르세요. 다른 페이지로 넘어가도 선택이 유지됩니다. **이 페이지 전체 선택**은 현재 페이지의 기록만, **모든 기록 선택**은 다른 페이지의 기록도 선택합니다. 삭제는 확인 창에서 수락한 뒤 진행됩니다.

**최근 노트 → 전체 내보내기 (ZIP)**를 누르면 모든 노트의 대화 원문과 저장된 요약을 Markdown 두 파일로 받습니다. 앱 내부 저장 정보는 빠지며, 파일 이름에 노트 기간이 표시됩니다. 예: `sitenote_(2026-10-01~2026-10-23)_원문.md`, `sitenote_(2026-10-01~2026-10-23)_요약.md`.

회의 후에는 음성 보충 질문을 이어가거나 **글로 보충하기**에서 AI 질문에 타이핑으로 답할 수 있습니다. **직접 질문과 답변 기록**은 마이크나 AI 연결 없이 사용할 수 있고, 내용은 같은 회의의 보충 기록에 저장됩니다. 회의 상세의 **화자 이름 관리**에서 각 화자의 첫 발언을 보고 이름을 입력하면 해당 화자의 모든 발언 표시와 Markdown 내보내기에 반영됩니다. 회의 본문과 보충 질문은 화자 번호를 별도로 부여하므로 같은 사람이라면 양쪽 그룹에 같은 이름을 입력하세요.

**분류별 → 새 폴더**에서 `업무 / 안전 점검`처럼 최대 3단계로 폴더를 만들 수 있습니다. 폴더의 **기록 추가**로 기존 녹음을 그 폴더로 옮깁니다. 노트의 **기록 설정 → 분류**에서도 경로를 수정할 수 있고, **AI 자동 분류**로 미분류 기록만 같은 트리에 넣을 수 있습니다. AI 분류를 누르면 제목, 프로젝트, 요약 또는 원문 일부가 OpenAI로 전송됩니다. **검색**에서 제목, 프로젝트, 분류, 원문과 요약을 찾을 수 있습니다. 검색 화면에서 AI에게 질문할 때는 사람의 발언만 사용합니다.

## Android 휴대폰에 직접 설치

1. Android 휴대폰에서 위 **APK 다운로드** 링크를 누릅니다.
2. 휴대폰 **파일 → 다운로드**에서 APK를 열고 **설치**를 누릅니다. Android가 막으면 안내에 따라 APK를 연 앱에 **이 출처 허용**을 켠 뒤 설치 화면으로 돌아옵니다. 설치가 끝나면 허용을 다시 끌 수 있습니다.
3. 홈 화면의 **SiteNote**를 엽니다. 이 APK는 내부에 앱을 포함하므로 USB, Metro, Expo Go가 필요 없습니다. 음성 기능에는 앱 **설정 → 서버 연결**에 휴대폰이 접속할 수 있는 **HTTPS 서버 주소와 접근 토큰**을 입력합니다. USB 테스트 때 썼던 `127.0.0.1` 주소는 쓰지 않습니다.

휴대폰에서 모든 노트를 저장하려면 **설정 → 저장 및 내보내기 → 전체 내보내기 (ZIP)**를 선택하고, 공유 화면에서 파일을 저장할 곳을 고르세요.

이 파일은 ARM64 Android용입니다. Android 15 에뮬레이터에서 설치 후 Metro 없이 홈 화면이 열리는 것을 확인했습니다. 이전 디버그 APK와는 서명이 달라 덮어쓸 수 없습니다. 디버그 앱에 남겨 둘 기록이 있다면 삭제하기 전에 내보내세요. 새 배포본을 기존 설치 위에 업데이트하려면 동일한 앱 ID와 서명 키를 사용합니다. 비공개 서명 파일은 `.local-signing/`에 보관하며 APK와 함께 복사하거나 공유하지 않습니다.

## 1. 서버 실행

Node 22.18 이상을 사용합니다. 운영하는 서버에 서비스 키를 준비한 뒤 다음을 실행합니다.

```sh
npm --prefix server ci
cp server/.env.example server/.env
openssl rand -hex 32
# server/.env에 생성한 SITE_ACCESS_TOKEN과 서비스 키를 입력
npm --prefix server start
```

| 환경변수 | 용도 |
| --- | --- |
| `SITE_ACCESS_TOKEN` | 32자 이상 앱 접속 전용 토큰. 서버와 앱 설정에 같은 값을 입력 |
| `OPENAI_API_KEY` | 서버에서만 사용하는 OpenAI 키. 녹음 중 AI 답변, 회의 후 보충질문, 목소리 들어보기에 모두 `gpt-live-1.1` 접근 필요 |
| `SONIOX_API_KEY` | 서버에서만 사용하는 Soniox 실시간 전사 키 |
| `OPENAI_TEXT_MODEL` | 요약·검색의 Responses 모델. 기본 `gpt-5.4-mini` |
| `SITE_HOST`, `SITE_PORT` | 기본 `127.0.0.1:8787` |
| `SITE_TLS_CERT`, `SITE_TLS_KEY` | 외부 기기에서 사용할 때 신뢰받는 인증서와 개인 키 PEM 경로 |

실기기에서 연결할 때는 기기가 신뢰하는 인증서가 적용된 HTTPS 주소를 사용합니다. 직접 TLS를 설정하거나 루프백 서버 앞에 사용자가 관리하는 HTTPS 역방향 프록시를 둘 수 있습니다. 프록시에서는 `/stream`의 WebSocket 업그레이드와 Bearer 헤더를 전달합니다. 서버는 참가자 음성, 원문, 요약을 디스크에 보관하지 않습니다. Soniox가 참가자 발언을 전사합니다. 녹음 중 질의응답에는 확정된 질문 텍스트와 참고 기록 일부가 OpenAI로 전달되고, 마이크 음성은 Soniox로만 전달됩니다.

## 2. 앱 실행

```sh
npm ci
npm run ios       # macOS + Xcode + CocoaPods; 실기기에는 -- --device
npm run android   # Android SDK + JDK + Android 기기 또는 에뮬레이터
npm start        # 이미 설치된 개발 빌드에 Metro를 다시 연결할 때
```

앱의 **설정 → 서버 연결**에서 주소와 접근 토큰을 저장합니다. 로컬 개발용으로 iOS 시뮬레이터는 `http://localhost:8787`, Android 에뮬레이터는 `http://10.0.2.2:8787`을 사용합니다. 연결 점검은 서버가 응답하는지와 제공자 키 설정 여부를 확인합니다. 제공자의 실제 모델 접근은 세션을 시작할 때 확인됩니다.

- **개인 대화**: 실시간 전사, 선택해서 여는 AI 음성 질의응답, 마이크 일시정지, 원문 저장과 요약.
- **회의**: 프로젝트 선택, 화자별 전사 및 이름 수정, **AI에게 질문**을 누른 구간에서만 음성 응답. 회의 참가자 발언은 Soniox 전사를 기준으로 저장합니다.
- **보완 대화**: 회의 원문 저장 후 만들어진 요약에서 시작합니다. 음성 질문을 건너뛰거나 종료할 수 있고, 보완 발언은 회의 원문과 구분됩니다. 종료하면 요약을 다시 만듭니다.
- **검색**: 이 기기의 원문 및 요약에서 단어 변형·한국어 용어의 유의어를 찾고, 관련 구간으로 이동합니다. 새 개인 기록은 기본으로 회의 중 AI의 참고 대상입니다. 기록 상세에서 **회의에서 이 개인 기록 참고하지 않음**을 켜면 제외할 수 있습니다. 검색은 정상 완료와 조회 실패를 다르게 표시합니다.

## 3. 파일과 복구

- 앱 내부 문서 폴더: `records/<record-id>/transcript.md`, `records/<record-id>/summary.md`. UTC로 저장하고 화면은 기기의 현지 시각을 사용합니다.
- 음성 사본은 기본 꺼짐입니다. 켜면 녹음 구간별 `audio-*.wav`를 같은 폴더에 저장합니다. 다른 사람의 발언이 AI 재생 시간과 겹치면 짧은 구간은 음소거됩니다. 앱 강제 종료 시 마지막 WAV 헤더가 완성되지 않을 수 있습니다.
- 기록 상세에서 개별 Markdown 및 음성 사본을 공유하고, 설정에서 전체 기록을 하나의 Markdown 파일로 공유합니다. 수정·삭제는 다음 검색부터 반영됩니다.
- 원문과 요약은 따로 저장합니다. 요약이 실패하면 원문이 남고 기록 상세에서 다시 요청할 수 있습니다. 연결이 끊긴 경우 재연결 이후부터 전사가 재개되며, 연결이 끊긴 동안의 음성은 소급 전사하지 않습니다. 연결 구간이 바뀌면 Soniox 화자 ID는 다시 부여되므로 이름도 새 구간에서 확인합니다.
- 일반 음성 질문에서는 스피커 반향과 구분되는 발화를 감지하면 재생을 중단합니다. 모바일 장치에서 감지 조건을 충족하지 못하면 **AI 음성 중단**을 누른 뒤 말하세요.
- 녹음 화면에서는 자동으로 화면이 잠기지 않습니다. 사용자가 기기를 직접 잠그거나 앱을 백그라운드로 보내면 녹음이 중단됩니다.

## 소스에서 배포 파일 만들기

Node.js 22.18 이상을 준비하고 프로젝트 루트에서 실행하세요. 아래 웹 빌드는 실행 중인 브라우저판과 별도 폴더에 생성합니다.

```sh
npm ci
npm ci --prefix server --omit=dev
npm exec -- vite build web --outDir ../dist/publish-web --emptyOutDir --assetsInlineLimit 0
node scripts/package-web.mjs --web-root=dist/publish-web
npm ci --prefix desktop
npm --prefix desktop run dist:mac    # macOS에서 DMG
npm --prefix desktop run dist:win    # Windows x64 휴대용 EXE
```

ZIP은 `dist/Sitenote-Desktop.zip`, DMG는 `dist/desktop-mac/`, EXE는 `dist/desktop-windows/`에 생성됩니다. Android 빌드는 [APK 빌드·서명 안내](scripts/android-release.md)를 따르세요. 공식 APK를 덮어쓸 수 있는 업데이트는 원래 서명 키로만 만들 수 있습니다.

## 4. 검증

```sh
npm run typecheck
npm run test:coverage
npm --prefix server test
npm run test:integration
npm run web:build
npm run test:web     # Chrome 필요, 모의 음성 제공자와 가상 마이크 사용
EXPO_NO_TELEMETRY=1 npm run prebuild -- --no-install
```

서버와 통합 테스트는 루프백 포트를 사용하며 제공자 응답을 모의 처리합니다. Android ARM64 디버그 APK는 빌드했고 Android 15 에뮬레이터에서 마이크 권한 승인, 입력 프레임에 대한 모의 전사, Markdown·WAV 저장 및 재실행 후 기록 복구를 확인했습니다. iOS는 네이티브 프로젝트 생성과 JavaScript 번들까지만 검증했습니다. 실제 제공자 연결, 실기기 음성 입출력·반향은 별도로 확인해야 합니다. 네이티브 오디오 검사 절차는 [오디오 모듈 문서](modules/site-audio/README.md)에 있습니다.

공식 프로토콜: [OpenAI GPT-Live WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets), [Soniox 실시간 WebSocket](https://docs.soniox.com/api-reference/stt/websocket-api), [Expo 개발 빌드](https://docs.expo.dev/develop/development-builds/introduction/).
