# Release 데모 clean-install 검증

제출 APK를 깨끗하게 설치한 뒤 release 데모를 확인하는 절차다. 2026-11-11 결과는 README에 적었다.

## 준비와 설치

- 최종 signed release와 별도 테스트용 clean Pleos Connect v2.1 / API34 환경을 사용한다. 기존 AVD를 임의로 wipe하지 않는다. 앱만 지우고 다시 설치했다면 결과에 `clean app install`로 적고 `fresh emulator`로 적지 않는다.
- SDK 도구 경로를 `ADB`, `APKSIGNER`, 지정 emulator를 `SERIAL`, 최종 APK를 `RELEASE_APK`로 설정한다. 현재 Android user를 조회해 `USER_ID`로 설정한다. 기본 user 번호를 추정하지 않는다.
- 증거는 저장소의 `.context/submit-prep/release-demo/` 아래에 저장한다. 개인 계정·일정·QR을 사용하지 않는다. 키나 비밀번호를 결과에 포함하지 않는다.

```sh
"$APKSIGNER" verify --print-certs "$RELEASE_APK"
shasum -a 256 "$RELEASE_APK"
"$ADB" -s "$SERIAL" shell am get-current-user
"$ADB" -s "$SERIAL" shell pm list packages -u dev.mobi
```

인증서 주체가 `CN=Mobi`이고 예상 fingerprint와 일치하는지 확인한다. 전용 테스트 환경에서 정확한 `package:dev.mobi` 행이 있으면 `adb uninstall dev.mobi`로 전체 사용자에서 제거한다. 현재 사용자에 앱이 없어도 다른 사용자의 debug 서명이 release 설치를 막을 수 있으므로 제거 후 `-u` 조회에서도 해당 행이 없는지 확인한다. `.test`/`.spike`는 다른 패키지다. 기존 연결·기어·forward 상태를 기록한 뒤 아래를 실행한다. 환경 값과 명령의 성공 여부도 증거에 남긴다.

```sh
"$ADB" -s "$SERIAL" install --user "$USER_ID" "$RELEASE_APK"
"$ADB" -s "$SERIAL" shell dumpsys package dev.mobi
"$ADB" -s "$SERIAL" emu avd hostmicoff
"$ADB" -s "$SERIAL" shell cmd connectivity airplane-mode enable
"$ADB" -s "$SERIAL" shell svc wifi disable
"$ADB" -s "$SERIAL" shell settings get global airplane_mode_on
"$ADB" -s "$SERIAL" shell settings get global wifi_on
"$ADB" -s "$SERIAL" forward tcp:8088 tcp:8088
curl -fsS -X POST 'http://127.0.0.1:8088/browser/session?client=mobi-release-demo'
curl -fsS -X PUT 'http://127.0.0.1:8088/vehicle/gear?gear=Park'
"$ADB" -s "$SERIAL" shell am start --user "$USER_ID" -n dev.mobi/.ui.MainActivity
```

Virtual Console session의 POST heartbeat를 별도 실행기로 초당 1회 유지하고 종료 시 정리한다. Park이면서 안전 제한이 없는 화면을 확인한다. 마이크 권한을 부여하지 않고, 실시간 기능·계정 연결을 선택하지 않는다. 패키지가 `dev.mobi`, expected version/min/target SDK이고 debuggable이 아닌지도 확인한다.

## 실제 화면 검증

1. **데모 보기**를 누르고 노크 뒤 응답 버튼이 보이면 **들을래요**를 누른다. 짧은 응답 창을 놓치면 데모를 다시 시작한다.
2. **하늘 · 오전 일정**과 가상 일정 상세를 screenshot/UI XML로 저장한다.
3. **다음**을 누르고 **도담 · 이동 안내**, 다시 **다음**으로 **새봄 · 오늘의 메모**를 각각 저장한다.
4. 한 번 더 **다음**을 눌러 **브리핑이 끝났어요**를 저장한다. 완료 후 다음 버튼이 숨겨지는지도 확인한다.
5. package dump에서 RECORD_AUDIO 미부여, `dumpsys activity services dev.mobi`에서 microphone FGS가 없음을 확인한다. 비행기 모드/Wi-Fi off 상태를 재확인한다.

탭은 실제 UI 노드 bounds 또는 수동 입력으로 한다. `DebugControls`, debug bounds/state, `run-as`, injected WAV 및 기존 `e2e/run.py install/demo`는 release 검증에 사용하지 않는다. UI hierarchy는 `adb shell uiautomator dump /sdcard/mobi-release-ui.xml`과 `adb exec-out cat /sdcard/mobi-release-ui.xml`, 화면은 `adb exec-out screencap -p`로 수집할 수 있다.

합격에는 **깨끗한 설치 + offline + 마이크 미부여 + 세 카드 + 완료**의 긍정적 증거가 모두 필요하다. 오류가 없었다는 사실만으로 PASS 처리하지 않는다. offline 성공으로 네트워크 시도 0까지 단정하지 않는다. `-no-audio` 환경의 playback 증거는 실제 소리를 청취한 증거와 구별한다.

## 결과와 정리

결과에 APK SHA-256, 인증서 subject/digest, 이미지 버전·API·AVD, 앱 version, clean 수준, 설치·연결·권한·FGS 상태와 각 화면 증거를 기록한다. 실제 serial은 공개용 문서에 싣지 않는다. 실패·누락은 그대로 남긴다.

기록한 연결/기어 상태를 복원하고 heartbeat를 중단한다. 이번에 만든 tcp:8088 forward와 guest UI dump를 제거한다. host mic을 끈 상태로 유지하고, 이 검증 전용으로 시작한 emulator만 종료한다. 다른 작업자의 emulator를 종료하지 않는다.
