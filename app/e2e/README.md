# Emulator foundation checks

Run these scripts from the Gradle root `app/`. They use Python's standard library, adb from `local.properties`, and the Virtual Console HTTP API forwarded on tcp:8088. No server account, remote service, package installation, or third-party Python dependency is required.

## Preconditions

- Build the debug APK and use the existing `Pleos_Connect_v2_1` AVD (API34).
- JDK17: `export JAVA_HOME=/opt/homebrew/opt/openjdk@17`.
- One online emulator; otherwise append `--serial <serial>` to each command and use the same `ANDROID_SERIAL` for Gradle instrumentation.
- Do not run device tests concurrently. The driver obtains the current Android user instead of assuming user10.
- The demo works without microphone input. The host user wears earphones. Acceptance therefore uses a debug-only injected PCM WAV source and keeps host input disabled; no acoustic loopback is used. `say -o` only generates a local source file and never plays it. Physical microphone accuracy is not claimed.
- Real boot requires one earlier user launch, notification permission, and a package that is not force-stopped. The driver prepares those conditions, performs adb reboot, then checks that the service runs with no Mobi Activity opened.

## Commands and assertions

```sh
./gradlew :app:connectedDebugAndroidTest --no-daemon
python3 e2e/run.py install
python3 e2e/run.py trip
python3 e2e/run.py dialog
python3 e2e/run.py driving --iterations 10 --max-hidden-ms 200
python3 e2e/run.py boot-buttons
python3 e2e/run.py demo-notification
python3 e2e/run.py demo --airplane --revoke-microphone
python3 e2e/run.py boot --real-park-seconds 600
python3 e2e/run.py microphone --capture-seconds 6
python3 e2e/run.py lifetime
python3 e2e/run.py verify-artifacts
```

- `install`: install -r, no automatic permission grants; launch and verify service/VC availability.
- `trip`: actual VC P/D plus debug-only monotonic Clock advances; three-minute P emits zero cues, ten-minute P emits one, duplicate D emits zero more. Exact 599999/600000/600001 boundaries are additionally JUnit assertions.
- `dialog`: parked demo cue→decline→mute and no response restoration after D/P; a new explicit demo→accept→briefing.
- `driving`: ten real VC Park/Drive transitions with visible cards before Drive. Match the actual car property timestamp in guest monotonic nanoseconds to the first hidden-frame pre-draw on the same clock. Save all ten latencies; each must be ≤200ms. The slower UI dump confirms absence of controls but is not used as the latency measurement.
- `boot-buttons`: verify parked notification response actions, transition to D before response, confirm DEFERRED and no reopening after P/stale tap. The DUMP-protected debug receiver captures an actual notification PendingIntent while parked, delivers that captured action after D/P, and requires a service receipt log before checking that DEFERRED remains unchanged. Notification action count must also become zero; a rejected shell command is not treated as this proof.
- `demo`: enable actual airplane mode and disable Wi-Fi, revoke RECORD_AUDIO, then use parked UI taps to complete all three pseudonymous cards. Assert no microphone FGS, and assert zero fixture requests/recordings during the demo; INTERNET is now required for live voice.
- `demo-notification`: the same three-card flow, leaving connectivity unchanged, accepted through a captured, currently valid notification PendingIntent while still parked. Assert the service receives it, the first card and Next are visible, all three cards are visited, and completion appears afterward. This regression runs before the separate offline demo in `all`.
- `boot`: real reboot, no Activity launch after boot, specialUse only, actual cue count one, actual 600-second parked service lifetime, first D without a duplicate cue. The driver prints a progress line each minute and continues the Virtual Console heartbeat.
- `microphone`: verifies the actual runtime permission dialog, real microphone FGS type, installed navigation foreground and service-owned response using a **debug-only injected WAV source**. The source exercises production EnergyVad and real WAV upload, then validates demo demotion and explicit live return. Host mic stays off. This replaces acoustic-loopback acceptance under the coordinator's earphone note; it does not claim physical microphone or Whisper accuracy.
- `lifetime`: while muted and navigation foreground, kill the current-user app process with run-as and prove PID change/sticky mute+microphone restoration using STATE evidence filtered to that new PID. Service creation initializes the persisted state even when Android recreates a bound service before delivering another start command. Force-stop separately, observe twenty seconds with no PID, change gear without resurrection, explicitly reopen and verify the same trip remains muted.
- `verify-artifacts`: compare wrapper SHA-256 with spike, validate actual debug/release APK manifests and release dex class list, require neutral dev.mobi/min+target34, INTERNET present, HTTPS-only release and no release DebugControls/CaptureProbe, and inspect the source files without pinning their count for whitespace/conflict markers.

To run all device scenarios sequentially after installing:

```sh
python3 e2e/run.py all --real-park-seconds 600 --iterations 10 --capture-seconds 6
```

A full run includes a real ten-minute park. Shortening that interval does not satisfy boot acceptance. Only the debug clock is accelerated; actual vehicle signals, boot delivery, service types, recording, and UI drawing are never faked. Fake final sentences test app state wiring only, not audio recognition.

## Evidence and cleanup

Evidence is saved under `.context/app-core/evidence/<scenario>-<timestamp>/`: results.json, scenario logcat, driving latency table, service/Activity dumps, UI XML/screenshots, and cleanup.json. Failed commands have their reason preserved. Failed setup, absent timestamps, or missing microphone energy are not PASS. No personal calendar content, tokens, microphone recordings, or private transcripts are captured. Generated fixture WAV files contain synthetic test speech only.

The driver maintains `POST /browser/session?client=mobi-app-core` every second and uses `PUT /vehicle/gear?gear=Park|Drive`. A reboot re-establishes forwarding and heartbeat. The driver restores original airplane/Wi-Fi/gear settings, resets the debug offset, disarms capture, disables host microphone input, and removes its forward in finally.

At the end of this implementation session the coordinator explicitly requires emulator shutdown, including an emulator that was already running:

```sh
"$ANDROID_HOME"/platform-tools/adb emu avd hostmicoff
"$ANDROID_HOME"/platform-tools/adb emu kill
pgrep -fl qemu
```

Wait for the emulator process to exit and confirm the final command has no process output. The image may keep macOS microphone ownership even after hostmicoff; emulator exit is required. Do not copy caches/AVDs, disable system speech apps, write to other worktrees, or commit/push these changes.

Use `--evidence-root app/build/e2e-evidence` to keep scenario evidence inside the app project instead of the default checkout CTX.

## Voice acceptance fixture

The extended driver starts `e2e/fake_server.py` on **127.0.0.1:8788**, forwards it with `adb reverse`, and keeps evidence under the requested worktree directory. It uses exact production JSON shapes and generated PCM WAV, never real OAuth/AI/personal schedules. The fixture output is a modest short tone with a silent tail. Input comes from the debug-only WAV source; host speaker/microphone routing is irrelevant. The parked tap latency scenario retains the authorized microphone stage across D but disables host input, so it measures taps without a competing voice reply. Separate voice scenarios inject synthetic speech WAV and exercise the production VAD. Recognition accuracy and cloud latency are not inferred from fixture transcripts.

```sh
python3 e2e/run.py install --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py instrumentation --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py pairing --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-knock --iterations 20 --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-confirm --iterations 20 --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-turn --iterations 20 --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-deadline --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-navigation --real-guidance --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-offline --evidence-root ../.context/voice-app/evidence
python3 e2e/run.py voice-privacy --evidence-root ../.context/voice-app/evidence
```

`instrumentation` runs connected tests with the fixture ready, then reinstalls the app. `pairing` scans the actual screenshot using macOS CoreImage via `e2e/qr-check.swift`, independently of ZXing, and checks that D stops polling and removes QR. It stores no actual credential in evidence.

`voice-knock` rotates 180/600/1800/null seconds and measures trip→MediaPlayer start and parked tap→briefing start after prefetch. `voice-confirm` and `voice-turn` use debug-only `InjectedWavInput`, generated with `say -o` and converted to PCM16/16kHz/mono; production EnergyVad, WAV serialization, upload, client deadlines and MediaPlayer remain real. Missing voiced PCM or a skipped source is a failure. Results explicitly mark physical microphone acceptance false. Samples save last voiced frame, VAD endpoint, local acknowledgement and result/playback-start timestamps. MediaPlayer start is accompanied by framework playback evidence; it is not a calibrated acoustic first-sample measurement.

`voice-deadline` delays the server eight seconds, requires the conversational turn expiry at eight seconds; confirmation retains its six-second request deadline and no later playback. `voice-navigation` first uses an actual debug AudioTrack with navigation usage to exercise the callback; `--real-guidance` additionally requires the installed navigation app to guide. If its route UI is unavailable, that check is **unverified/failed**, never replaced by synthetic success. Callback pause ≤300ms does not imply literal zero overlap; keep actual audio-event evidence.

`voice-offline` caches the production informational WAV, turns off actual connectivity, and drives real Park→Drive departures after advancing only the trip clock by ten minutes. It measures the vehicle source timestamp→playback callback against 5,000ms, then separately waits for full speech completion. A second departure with its cache manifest removed must remain silent for over five seconds. Both cases require zero requests, recording, extra/error speech. Physical first sound is not inferred from a callback. `voice-privacy` scans synthetic markers and checks encrypted token storage and empty temporary-audio directories. Validated today cache WAV is retained intentionally. `verify-artifacts` now requires INTERNET, rejects release loopback cleartext/debug receivers and inspects files without a fragile fixed source-file count.

All scenarios are sequential. The extended `all` keeps the original nine foundation checks (including a real ten-minute park), then runs these eight voice scenarios at the chosen iteration count. Each finally block restores the debug origin, disarms capture/navigation, restores connectivity/gear, disables host mic, removes forwards/reverse and terminates any fixture it started. At session end also kill the emulator and verify no qemu process remains.

### Host audio isolation

The acceptance run uses the same `Pleos_Connect_v2_1` AVD with a temporary `-no-audio` startup flag. The host CoreAudio backend repeatedly returned `kAudioHardwareIllegalOperationError` after earphone routing changes. Disabling host audio avoids that driver dependency while retaining Android MediaPlayer/AudioPlaybackCallback and the debug WAV input path. This measures virtual Android playback start/completion; it does not verify physical first sound, listening quality or actual microphone accuracy. No global audio/AVD settings or caches are changed.

```sh
"$ANDROID_HOME"/emulator/emulator -avd Pleos_Connect_v2_1 -no-snapshot -no-boot-anim -netdelay none -netspeed full -no-audio
```

### Preserve an existing real-account pairing during native tests

`connectedDebugAndroidTest` can uninstall its target app and remove its Keystore-backed device credential. For an already paired emulator, assemble the debug and Android-test APKs, install both with `adb install -r`, and invoke `am instrument --user <current-user> -w -r dev.mobi.test/androidx.test.runner.AndroidJUnitRunner` directly. Keep the native API tests on their loopback fixture origin, then restore the real origin. This preserves the main package's data and credential; do not uninstall or clear the main package between matched live arms. The three-day package used this method for its final 35-test native verification.
