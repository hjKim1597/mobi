# 모비 (Mobi)

차량의 주행 상태에 맞춰 오늘 일정을 안내하는 인카 AI 비서입니다. 정차 중에는 카드와 버튼을 제공하고, 주행 중에는 화면 조작을 제한합니다.

- 새 트립 감지와 일정 노크, 오늘 일정 카드·브리핑
- Google Calendar·Gmail QR 계정 연결과 서버 기반 음성 응답
- 회신이 필요한 메일에 음성으로 답장하고, 메일이나 음성 명령으로 Google Calendar 일정 추가. 보내거나 추가하기 전에 전체 내용을 다시 읽고, '보내'·'추가해'로 승인한 뒤 10초 동안 '취소'를 받습니다.
- 로그인·서버·마이크 없이 동작하는 데모 일정·메일 체험

## APK 설치와 데모

제출 APK: [apk/MOBI_Mobi_release.apk](apk/MOBI_Mobi_release.apk)

Android SDK의 `adb`로 연결된 Pleos 에뮬레이터에 설치합니다. 여러 기기가 연결되어 있으면 `-s <serial>`로 대상을 지정하세요.

```sh
adb install apk/MOBI_Mobi_release.apk
adb shell am start -n dev.mobi/.ui.MainActivity
```

P(정차)이고 안전 제한이 없는 화면에서 **데모 보기 → 들을래요 → 다음**을 눌러 데모 일정 세 장과 완료 화면을 확인합니다. 이어서 데모 메일의 회신 작성과 후속 일정 추가 흐름도 볼 수 있습니다. 인터넷·Google 로그인·마이크 권한이 필요하지 않습니다. **hostmicon이 없으면 데모 모드 탭으로 시연**합니다. D/R/N 또는 차량 상태를 확인할 수 없는 경우에는 조작 버튼이 숨겨집니다.

## 실제 서버 연결

네트워크에 연결한 뒤 P에서 **계정 연결**을 선택합니다. 휴대폰 기본 브라우저로 QR을 열고 Google 동의를 완료하세요. 연결 후 오늘 일정이 표시됩니다. 음성 기능은 **실시간 기능**을 선택하고 마이크 권한을 허용해야 합니다. 서버의 Google OAuth·암호화 키 설정이 필요하며, 자세한 실행법은 [서버 문서](docs/api.md#로컬-실행과-검증)를 참고하세요. 비밀 값은 소스에 넣지 않습니다.

## 소스 빌드

Android SDK 경로를 로컬 `app/local.properties`의 `sdk.dir`에 설정하고, `JAVA_HOME`을 JDK 17로 지정합니다. 서버 개발에는 Node.js 22를 사용합니다.

```sh
cd app
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease --offline --no-daemon
TEAM_NAME='MOBI' ./gradlew :app:exportSubmissionApk --offline --no-daemon
python3 e2e/run.py verify-artifacts
```

오프라인 빌드는 의존성이 미리 캐시되어 있어야 합니다. 제출 APK 이름은 `apk/<팀명>_Mobi_release.apk`이며, 팀명은 `MOBI`이고 `TEAM_NAME`을 생략해도 같은 이름으로 생성됩니다.

서명키와 비밀번호 설정은 [앱 빌드 문서](app/README.md#release-signing-and-submission-apk)를 따릅니다. 서명 정보가 없으면 `assembleRelease`는 unsigned APK를 만들고, `exportSubmissionApk`는 명확한 오류로 중단됩니다. 키·비밀번호·로컬 설정은 제출 저장소에 포함하지 않습니다.

## 테스트 환경

| 항목 | 환경 |
|---|---|
| 차량 에뮬레이터 | Pleos Connect v2.1, Android Automotive OS API 34 |
| AVD | `Pleos_Connect_v2_1` |
| Android 빌드 | JDK 17, Gradle 8.10.2, AGP 8.8.2, Kotlin 2.0.0, compile SDK 35 |
| 앱 지원 범위 | min/target SDK 34, 패키지 `dev.mobi` |
| 서버 | Node.js 22, Cloudflare Workers |

앱과 서버의 모든 단위 테스트가 통과했습니다. SHA-256 `6704f53d14d1…`인 이전 APK의 깨끗한 설치 후 release 데모와 Google 계정 연결이 **2026-11-11**에 통과했습니다. 데모 문구를 고친 현재 APK(SHA-256 `47ad85dad72d…`)는 **2026-11-15**에 이전 APK 위에 업데이트 설치해 release 데모(데모 메일 회신·일정 추가 포함)와 실제 Google 계정의 출발 노크·메일 회신을 다시 확인했습니다. lint·빌드·APK 구조/서명 검증도 통과했으며, [데모 검증 절차](app/e2e/release-demo.md)를 제공합니다. 실제 차량·마이크·클라우드 성능은 별도 검증 대상입니다.
