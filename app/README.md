# Mobi Android foundation

An anonymous AAOS app foundation for trip detection (A6), sentence intent classification (A9), safe parked/driving screens (A10), a two-stage foreground service (A13), and an offline demonstration (A3).

The Gradle root is this directory. `:app` is the single application module under `app/`, with package `dev.mobi`. It runs on Android Automotive API 34. Compilation uses installed SDK 35, AGP 8.8.2, Kotlin 2.0.0, Gradle 8.10.2, and JDK 17. The wrapper is copied unchanged from the spike. The Pleos image supplies car classes at runtime without advertising `android.car` as a required shared library, so the manifest marks that library optional.

## Build and run

Set `JAVA_HOME` to JDK 17 and configure `sdk.dir` in the local, ignored `app/local.properties`. From the checkout root:

```sh
cd app
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease --offline --no-daemon
```

If the offline failure specifically identifies an uncached dependency, rerun without `--offline`. Existing Gradle/Android caches and the existing `Pleos_Connect_v2_1` AVD are used in place. Do not copy an AVD, install global packages, edit global settings, or accept new SDK licenses. Debug APK: `app/build/outputs/apk/debug/app-debug.apk`. Release APK: `app/build/outputs/apk/release/app-release.apk` when private signing is configured, otherwise `app-release-unsigned.apk` in the same directory.

## Release signing and submission APK

The release keystore lives outside every checkout at `~/.mobi/mobi-release.jks` (directory 700, file 600), with alias `mobi-release`, RSA 4096 and a neutral `CN=Mobi` certificate. Keep a secure backup. Store the independently generated store/key passwords only in private `~/.gradle/gradle.properties` (file 600) as `mobiReleaseStorePassword` and `mobiReleaseKeyPassword`. Never print or commit their values. Gradle reads these through `providers.gradleProperty`; optional `mobiReleaseStoreFile` and `mobiReleaseKeyAlias` override the defaults.

Without both passwords and the keystore, `assembleRelease` remains available and produces an unsigned APK. The submission task fails clearly instead of exporting it:

```sh
TEAM_NAME='MOBI' ./gradlew :app:exportSubmissionApk --offline --no-daemon
```

This copies the signed release to the repository's `apk/<TEAM_NAME>_<app display name>_release.apk`, defaulting to the team name `MOBI` (`apk/MOBI_Mobi_release.apk`). `TEAM_NAME` is the single team-name input and supports Korean names. APKs in `apk/` must be committed for the contest; build outputs remain ignored. Keystores and local signing properties are ignored and must stay out of the export.

Verify the final copy with the SDK's `apksigner verify --print-certs` and record its certificate subject, SHA-256 certificate digest and APK SHA-256. Signing passwords must not appear in command arguments or logs. [Release demo acceptance](e2e/release-demo.md) uses production UI and is separate from the debug harness.

## Debug install and live behavior

With an emulator reserved for this task running (the installer below uses the debug APK):

```sh
python3 e2e/run.py install
```

Open Mobi. In P with no UX restrictions, choose **데모 보기** to hear a local cue, tap **들을래요**, and advance through three clearly fictional briefing cards. The demo needs no login, server, network connection, or microphone grant; the app declares INTERNET for live features. Without `hostmicon`, demonstrate the app using these parked taps. Demo reset never resets the live trip's mute state. In D, R, N, unknown vehicle state, or restricted UX, the app shows status only.

Choose **실시간 기능** while parked to request notification/microphone access. Microphone FGS promotion follows the explicit user action and only occurs while the Activity is visible. Permission rejection leaves the service in its non-microphone stage.

## Service and safety

A real BOOT_COMPLETED starts `specialUse` and subscribes to gear/UX signals without launching the Activity. It emits one local trip cue. The first departure belongs to that boot trip; a later uninterrupted P period of at least ten minutes followed by the first D creates another trip. Time uses a monotonic injected Clock and is paired with BOOT_COUNT. Trip/mute/knock consumption are committed before effects. A crash between the commit and the cue can skip a cue; it cannot replay it on restart.

After explicit foreground permission, the service adds `microphone`. Same-boot ordinary process death uses START_STICKY recovery and attempts to restore that stage. Android may deny it, in which case the app reports microphone unavailable and remains `specialUse`. Force-stop stops the app until it is explicitly reopened; reopening preserves trip mute. A new boot invalidates the previous microphone promotion.

The six-second no-answer window follows a knock. A separate absolute six-second deadline covers a voice request from its last voiced frame, including VAD silence, upload, server processing, download, decoding, and playback start. An explicit decline mutes the trip. No answer or an ambiguous sentence defers without muting or retrying. Before microphone promotion, D before a parked response hides its buttons and defers; returning to P does not reopen them. Current gear/UX is checked again when actions arrive.

## Live voice and pairing

While parked, choose **계정 연결**, scan the QR in a phone browser, and finish Google consent on the server page. The app registers once, encrypts its device token with Android Keystore, and polls for at most five minutes. Leaving the screen, a driving restriction, or entering demo removes the QR and stops polling. Expired/failed codes can be retried while parked. OAuth tokens never enter the app.

The server origin is configurable at build time:

```sh
./gradlew :app:assembleDebug -PmobiServerBaseUrl=https://mobi-dev.mobi-car.workers.dev --offline --no-daemon
```

The default origin is `https://mobi-dev.mobi-car.workers.dev`. Release permits HTTPS only; a DUMP-protected debug override and debug-only network-security config allow loopback HTTP for the acceptance fixture. ZXing core 3.5.4 renders the complete pairing URL locally; no QR service is used.

A successful `/v1/today` caches calendar events and the server's online/offline knock WAV files in private app storage. SHA-256, version, calendar date and calendar time zone are checked before use. Offline knocks only provide information; absent, damaged or out-of-date cache means silence. Demo remains the existing local tone and fictional cards, with no registration, network calls or recording.

At an online trip knock, the app prefetches `/v1/briefings` while the cached knock begins. NaviHelper remaining time is in seconds: below 300 = short, 300–899 = summary, 900+ = full; an absent route selects summary. The app only reads navigation data. With a prefetched WAV ready, parked acceptance or an accepted voice response starts the briefing promptly. A late result is discarded. Question and confirmation errors use their matching pre-recorded local WAV when the current session, navigation state, audio focus, and six-second response limit allow it; no synthesis is started after an error. A returned degraded question sentence is played once as the normal server response.

After explicit foreground microphone activation, AudioRecord captures PCM16 little-endian / 16kHz / mono. Confirmation uses 500ms silence and `/v1/confirm`; parked **말하기** uses 700ms silence and `/v1/turns`. Both cap recording at eight seconds and reject low-energy input. Recording and playback alternate. The exact sentence dictionary remains authoritative; advisory server matches cannot promote an ambiguous result, and P0 never invokes external action APIs. Parked response buttons remain available.

MediaPlayer plays the server's base64 WAV at its header sample rate (including 44.1kHz). AudioFocus and AudioPlaybackCallback detect NAVIGATION_GUIDANCE; the app checks active configurations before playback, pauses immediately on guidance, and discards recording contaminated by guidance. A callback may arrive after guidance begins, so literal zero acoustic overlap still needs actual navigation/vehicle measurement. Silence, noise and speaker echo also require real-car validation; fake-server tests do not measure Whisper accuracy or cloud latency. Acceptance uses a debug-only injected PCM WAV source because the host user wears earphones; it never depends on Mac speaker-to-microphone loopback. Playback fixture levels stay modest.

The debug variant retains its service-owned six-second raw capture probe, final-sentence injection and accelerated **trip-only** clock. Production IO deadlines use real monotonic time. Debug commands, test navigation output and loopback configuration are absent from release entry points. Confirm VAD is fixed at 500ms and question VAD at 700ms. The DUMP-protected `package-current` and `package-candidate` commands select the A/B package; current disables local failure playback and candidate enables it. Both use the same VAD settings. Release always enables the bundled failure WAVs, matching the debug default.

For paired, parked, visible debug measurement, first install the fixture as `voice-fixture.wav` in private app storage and configure it with `input-wav`. The DUMP-protected receiver commands are:

```sh
adb shell am broadcast -n dev.mobi/.DebugControls --es command package-current
adb shell am broadcast -n dev.mobi/.DebugControls --es command measure-confirm --es id c01
adb shell am broadcast -n dev.mobi/.DebugControls --es command measure-turn --es id q01
adb shell am broadcast -n dev.mobi/.DebugControls --es command measure-briefing --es id b01
```

Use `package-candidate` before the candidate block; both arm selectors keep confirm VAD at 500ms.

The confirm and turn commands enter the real capture, VAD, authenticated request, and local decision/playback path without playing a knock or prefetching a briefing. A briefing command makes one authenticated request for the current trip and does not start capture. Each command requires the app to be on the fixed mobi-dev origin and reports only route, safe request ID, response status/outcome, timestamps, origin allowlist result, paired state, and selected package arm. It does not log audio, transcript, token, or response text. Run these controls only in the debug build while the app is visibly parked with microphone permission and audio focus available.

PCM is never written to disk by normal capture; the debug WAV fixture is explicitly installed in private app storage for measurement. Temporary response WAV files are deleted at completion/cancellation and startup, while validated knock cache files deliberately remain. Tokens, transcripts, QR URLs and calendar titles are excluded from app logs.

## Verify

See [e2e/README.md](e2e/README.md) for actual gear transitions, reboot, driving latency, offline demo, microphone input, and lifecycle tests. Unit tests cover the exact sixty-sentence table, trip boundaries, state transitions, the safety gate, service policy, and demo sessions. Android instrumentation verifies persistent storage and native UI/stale actions.

```sh
./gradlew :app:connectedDebugAndroidTest --no-daemon
python3 e2e/run.py verify-artifacts
```

The harness saves timestamped evidence under the checkout's git-ignored `.context/app-core/evidence/`. A missing controlled microphone input, unsupported source timestamp, or skipped test is a validation gap, not a pass. At the end of this coordinated implementation session, disable host microphone input and terminate the emulator to release macOS microphone ownership; verify no qemu process remains.
