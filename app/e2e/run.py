#!/usr/bin/env python3
"""Mobi foundation verification. Only adb + Virtual Console + standard Python."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import wave
import array
sys.dont_write_bytecode = True

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
PACKAGE = "dev.mobi"
ACTIVITY = "dev.mobi/.ui.MainActivity"
NAVIGATION = "ai.umos.maps.android.navigation.app/.MainActivity"
SDK = Path(next(line.split("=", 1)[1] for line in (APP / "local.properties").read_text().splitlines() if line.startswith("sdk.dir=")))
ADB = SDK / "platform-tools/adb"
JAVA = "/opt/homebrew/opt/openjdk@17"


def run(arguments, *, binary=False, timeout=30, check=True):
    name = Path(str(arguments[0])).name
    tool = name if name in {"adb", "gradlew", "apkanalyzer", "swift", "say", "afconvert"} else "tool"
    try:
        result = subprocess.run([str(x) for x in arguments], capture_output=True, timeout=timeout,
                                text=not binary, env=dict(os.environ, JAVA_HOME=JAVA))
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Command timed out: {tool}") from None
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {tool}")
    return result.stdout


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for(predicate, message, timeout=20, interval=.3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"Timed out: {message}")


def verify_tracked_signing_properties():
    paths = run(["git", "-C", ROOT, "ls-files", "-z", "--", "*.properties"], binary=True).decode().split("\0")
    checked = 0
    for path in filter(None, paths):
        file = ROOT / path
        if not file.is_file():
            continue
        checked += 1
        keys = re.findall(r"^\s*(mobiRelease[^\s=:]*Password)(?=\s|=|:|$)", file.read_text(), re.M)
        require(not keys, "Tracked signing password keys: " + ", ".join(sorted(set(keys))))
    return checked


def verify_artifacts():
    tracked_properties = verify_tracked_signing_properties()
    analyzer = SDK / "cmdline-tools/latest/bin/apkanalyzer"
    debug = APP / "app/build/outputs/apk/debug/app-debug.apk"
    release_dir = APP / "app/build/outputs/apk/release"
    metadata = json.loads((release_dir / "output-metadata.json").read_text())
    require(len(metadata["elements"]) == 1, "Expected one release APK")
    release = release_dir / metadata["elements"][0]["outputFile"]
    release_signed = release.name == "app-release.apk"
    for apk in (debug, release):
        manifest = run([analyzer, "manifest", "print", apk])
        require('android.permission.INTERNET' in manifest, "Voice app needs INTERNET")
        require('package="dev.mobi"' in manifest, "Package must remain neutral")
        require('android:targetSdkVersion="34"' in manifest, "Target SDK must be 34")
        require('android:minSdkVersion="34"' in manifest, "Minimum SDK must be 34")
        require('android:compileSdkVersion="35"' in manifest or 'platformBuildVersionCode="35"' in manifest, "Compile SDK must be 35")
        if apk == release:
            require('android:debuggable="true"' not in manifest, "Release is debuggable")
            require("networkSecurityConfig" not in manifest and 'usesCleartextTraffic="true"' not in manifest, "Release permits test cleartext")
            require("DebugControls" not in manifest and "dev.mobi.initializer" not in manifest, "Debug manifest leaked into release")
            packages = run([analyzer, "dex", "packages", "--defined-only", apk])
            require("DebugControls" not in packages and "CaptureProbe" not in packages and "InjectedWavInput" not in packages, "Debug classes leaked into release")
        else:
            require("android.permission.DUMP" in manifest and "DebugControls" in manifest, "Debug control must be DUMP protected")
    for apk in (debug, release):
        with zipfile.ZipFile(apk) as package:
            for name in ("confirm_failure.wav", "question_failure.wav"):
                expected = (APP / "app/src/main/res/raw" / name).read_bytes()
                require(any(package.read(path) == expected for path in package.namelist() if path.endswith(".wav")), f"Fixed failure asset missing or changed: {name}")
    for relative in ("gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"):
        require(hashlib.sha256((APP / relative).read_bytes()).digest() == hashlib.sha256((ROOT / "spike" / relative).read_bytes()).digest(), f"Wrapper changed: {relative}")
    source_files = []
    for path in APP.rglob("*"):
        if not path.is_file() or any(part in {"build", ".gradle", ".gradle-user", ".kotlin"} for part in path.relative_to(APP).parts):
            continue
        source_files.append(str(path.relative_to(APP)))
        if path.suffix in {".kt", ".kts", ".xml", ".py", ".md", ".pro", ".properties"}:
            text = path.read_text()
            require(not any(line.rstrip() != line for line in text.splitlines()), f"Trailing whitespace: {path}")
            require(not re.search(r"^(<<<<<<<|=======|>>>>>>>)", text, re.M), f"Conflict marker: {path}")
    ast.parse(Path(__file__).read_text())
    require(source_files, "No source files inspected")
    print(json.dumps({"scenario": "verify-artifacts", "result": "PASS", "sourceFiles": len(source_files), "releaseDebugClasses": 0, "releaseSignedOutput": release_signed, "internetPermission": True, "trackedPropertiesChecked": tracked_properties}))


class Harness:
    def __init__(self, options):
        self.options = options
        devices = run([ADB, "devices"]).splitlines()[1:]
        online = [line.split()[0] for line in devices if "\tdevice" in line and line.startswith("emulator-")]
        self.serial = options.serial or (online[0] if len(online) == 1 else None)
        require(self.serial is not None and self.serial in online, "Select exactly one online emulator with --serial")
        self.user = self.adb("shell", "am", "get-current-user").strip()
        require(self.user.isdigit(), "Unknown foreground Android user")
        evidence_root = Path(getattr(options, "evidence_root", None) or ROOT / ".context/app-core/evidence")
        self.evidence = evidence_root / (options.scenario + "-" + time.strftime("%Y%m%d-%H%M%S"))
        self.evidence.mkdir(parents=True)
        self.stop_heartbeat = threading.Event()
        self.heartbeat_thread = None
        self.original_airplane = self.adb("shell", "settings", "get", "global", "airplane_mode_on").strip()
        self.original_wifi = self.adb("shell", "settings", "get", "global", "wifi_on").strip()
        self.original_gear = None
        self.results = []
        self.fixture = None
        self.fixture_log = None
        self.fixture_active = False

    def adb(self, *arguments, **kwargs):
        return run([ADB, "-s", self.serial, *arguments], **kwargs)

    def logs(self):
        return self.adb("logcat", "-d", "-s", "Mobi:I", "*:S")

    def save(self, name, value):
        path = self.evidence / name
        if isinstance(value, bytes):
            path.write_bytes(value)
        elif isinstance(value, str):
            path.write_text(value)
        else:
            path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")

    def command(self, command, **extras):
        args = ["shell", "am", "broadcast", "--user", self.user, "-n", "dev.mobi/.DebugControls", "--es", "command", command]
        for name, value in extras.items():
            args += ["--el" if isinstance(value, int) else "--es", name, str(value)]
        output = self.adb(*args)
        require("Permission Denial" not in output, "Debug receiver rejected shell")
        return output

    def state(self):
        self.command("state")
        pid = wait_for(lambda: (lambda value: value if value.isdigit() else None)(self.adb("shell", "pidof", PACKAGE, check=False).strip()), "one current app process for state evidence", 10)
        matches = wait_for(lambda: re.findall(r"STATE (\{[^\n]+\})", self.adb("logcat", "-d", "--pid=" + pid, "-s", "Mobi:I", "*:S")), "current-process service state evidence", 10)
        return json.loads(matches[-1])

    def until_state(self, predicate, message, timeout=20):
        return wait_for(lambda: (lambda state: state if predicate(state) else None)(self.state()), message, timeout)

    def vc(self, path, method="PUT"):
        request = urllib.request.Request("http://127.0.0.1:8088" + path, method=method, data=b"" if method == "POST" else None)
        with urllib.request.urlopen(request, timeout=3) as response:
            require(200 <= response.status < 300, f"Virtual Console failed: {path}")
            return response.read()

    def connect_vc(self):
        self.adb("forward", "tcp:8088", "tcp:8088")
        if self.fixture_active:
            self.adb("reverse", "tcp:8788", "tcp:8788")
        def ready():
            try:
                self.vc("/browser/session?client=mobi-app-core", "POST")
                return True
            except (OSError, TimeoutError):
                return False
        try:
            wait_for(ready, "VC session", 10)
        except AssertionError:
            # The image can leave the console HTTP listener stalled after an offline
            # transition. Reopen its installed UI; do not reset or disable system apps.
            self.adb("shell", "am", "start", "--user", self.user, "-n", "ai.pleos.connectwebconsole/.FormFactorConsoleActivity")
            wait_for(ready, "restored VC session", 20)
        if self.heartbeat_thread is None:
            def heartbeat():
                while not self.stop_heartbeat.wait(1):
                    try:
                        self.vc("/browser/session?client=mobi-app-core", "POST")
                    except Exception:
                        pass  # Main scenario operations still require successful HTTP responses.
            self.heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
            self.heartbeat_thread.start()

    def gear(self, name):
        self.vc("/vehicle/gear?gear=" + name)
        expected = {"Park": "PARK", "Drive": "DRIVE"}[name]
        return self.until_state(lambda state: state["gear"] == expected and (name != "Park" or state["interactive"]), f"gear {name}")

    def open(self):
        require(self.adb("shell", "pm", "path", "--user", self.user, PACKAGE).strip().startswith("package:"), "Install the debug APK first; Gradle connected tests can uninstall their target")
        self.adb("shell", "am", "start", "--user", self.user, "-f", "0x20000000", "-n", ACTIVITY)
        self.until_state(lambda state: "tripId" in state, "service initialized")

    def hierarchy(self):
        self.adb("shell", "uiautomator", "dump", "/sdcard/mobi-ui.xml", timeout=15)
        text = self.adb("shell", "cat", "/sdcard/mobi-ui.xml")
        return ET.fromstring(text)

    def node(self, name):
        resource = name if ":id/" in name else "dev.mobi:id/" + name
        return next((node for node in self.hierarchy().iter("node") if node.get("resource-id") == resource), None)

    def tap(self, name):
        if name in {"accept","decline","demo","live","next","connect","speak"}:
            def visible_bounds():
                request=str(time.monotonic_ns())
                self.command("bounds",view=name,request=request)
                matches=re.findall(r"UI_BOUNDS request="+request+r" view="+name+r" bounds=([0-9,]+)",self.logs())
                return list(map(int,matches[-1].split(","))) if matches else None
            numbers=wait_for(visible_bounds,"native visible control "+name,3,.1)
        else:
            node = self.node(name)
            require(node is not None, f"Visible UI control missing: {name}")
            numbers = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
        require(len(numbers) == 4, f"Invalid bounds: {name}")
        self.adb("shell", "input", "tap", str((numbers[0] + numbers[2]) // 2), str((numbers[1] + numbers[3]) // 2))

    def baseline(self):
        self.open()
        self.gear("Drive")
        self.command("baseline")
        state = self.until_state(lambda state: state["state"] == "IDLE" and not state["demo"], "test baseline")
        return state

    def next_trip(self):
        self.gear("Park")
        self.command("advance", millis=600000)
        return self.gear("Drive")

    def screenshot(self, name):
        self.save(name + ".png", self.adb("exec-out", "screencap", "-p", binary=True))

    def install(self):
        output = self.adb("install", "-r", APP / "app/build/outputs/apk/debug/app-debug.apk", timeout=60)
        require("Success" in output, "APK installation failed")
        self.save("install.txt", output)
        self.open()
        self.connect_vc()
        return {"installed": True, "user": int(self.user)}

    def trip(self):
        self.baseline()
        initial = len(re.findall(r"KNOCK trip=", self.logs()))
        self.gear("Park")
        self.command("advance", millis=180000)
        self.gear("Drive")
        short = len(re.findall(r"KNOCK trip=", self.logs()))
        require(short == initial, "3-minute P triggered a knock")
        self.next_trip()
        long_count = len(re.findall(r"KNOCK trip=", self.logs()))
        require(long_count == initial + 1, "10-minute P did not trigger exactly one knock")
        wait_for(lambda: bool(re.search(r"CUE_PLAY trip=", self.logs())), "actual non-microphone trip cue playback", 5)
        self.gear("Drive")
        require(len(re.findall(r"KNOCK trip=", self.logs())) == long_count, "Duplicate D replayed knock")
        return {"shortParkKnocks": 0, "longParkKnocks": 1, "duplicateKnocks": 0}

    def dialog(self):
        self.baseline()
        self.gear("Park")
        self.tap("demo")
        self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "demo response")
        self.tap("decline")
        self.until_state(lambda state: state["state"] == "MUTED" and state["muted"], "demo muted")
        self.gear("Drive")
        self.gear("Park")
        nodes = self.hierarchy()
        require(not any(node.get("resource-id") in {"dev.mobi:id/accept", "dev.mobi:id/decline"} for node in nodes.iter("node")), "Muted response buttons returned")
        self.tap("demo")
        self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "new demo response")
        self.tap("accept")
        self.until_state(lambda state: state["state"] == "BRIEFING", "demo accepted")
        return {"declineMuted": True, "repeatKnockAfterDecline": False, "acceptBriefing": True}

    def driving(self):
        self.baseline()
        latencies = []
        for iteration in range(self.options.iterations):
            self.gear("Park")
            self.tap("demo")
            self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "visible response card")
            require(self.node("cards") is not None, "No card before Drive")
            require(self.state()["state"] == "AWAITING_RESPONSE", "Response expired before Drive; latency sample is invalid")
            host_started = time.monotonic()
            state = self.gear("Drive")
            host_rtt = (time.monotonic() - host_started) * 1000
            source = state["sourceNs"]
            require(source > 0, "No source timestamp; actual gear-to-draw acceptance is unverified")
            def hidden_draw():
                values = [int(draw) for src, draw in re.findall(r"DRAW_HIDDEN sourceNs=(\d+) drawNs=(\d+)", self.logs()) if int(src) == source and int(draw) >= source]
                return min(values) if values else None
            draw = wait_for(hidden_draw, "hidden first draw", 5)
            latency = (draw - source) / 1000000
            require(latency <= self.options.max_hidden_ms, f"Gear-to-hidden-frame {latency:.2f}ms > {self.options.max_hidden_ms}ms")
            nodes = self.hierarchy()
            forbidden = {"cards", "accept", "decline", "demo", "live", "next", "connect", "speak", "pairing_qr", "pairing_status"}
            require(not any(node.get("resource-id") in {"dev.mobi:id/" + name for name in forbidden} for node in nodes.iter("node")), "Driving UI includes interactive controls")
            latencies.append({"iteration": iteration + 1, "sourceNs": source, "drawNs": draw, "hiddenMs": latency, "hostRequestAndStateMs": host_rtt})
        self.save("latencies.json", latencies)
        self.screenshot("driving")
        return {"iterations": len(latencies), "maxHiddenMs": max(row["hiddenMs"] for row in latencies)}

    def boot_buttons(self):
        self.adb("shell", "pm", "grant", "--user", self.user, PACKAGE, "android.permission.POST_NOTIFICATIONS")
        self.baseline()
        self.gear("Park")
        self.tap("demo")
        response = self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "parked response")
        before = self.adb("shell", "dumpsys", "notification", "--noredact")
        self.save("notification-before.txt", before)
        require("들을래요" in before and "됐어요" in before, "Parked notification response actions missing")
        self.command("capture-notification-action")
        self.gear("Drive")
        self.until_state(lambda state: state["state"] == "DEFERRED", "D-before-tap becomes NOT_NOW")
        self.gear("Park")
        self.command("notification-actions")
        actions = re.findall(r"NOTIFICATION actions=(\d+)", self.logs())
        require(actions and actions[-1] == "0", "D/DEFERRED notification retained response actions")
        self.command("send-captured-action")
        wait_for(lambda: f"NOTIFICATION_RESPONSE trip={response['tripId']}" in self.logs(), "captured PendingIntent delivered to service", 5)
        state = self.state()
        require(state["state"] == "DEFERRED", "Captured stale action reopened deferred response")
        after = self.adb("shell", "dumpsys", "notification", "--noredact")
        self.save("notification-after.txt", after)
        return {"parkedActionsPresent": True, "dBeforeTapDeferred": True, "actionsAfterDrive": 0, "capturedStaleActionDelivered": True, "staleResponseIgnored": True}

    def demo_notification(self):
        return self.demo_case(accept_via="notification", offline=False)

    def demo_case(self, accept_via="card", offline=True):
        self.baseline()
        self.gear("Park")
        self.adb("shell", "pm", "revoke", "--user", self.user, PACKAGE, "android.permission.RECORD_AUDIO")
        if offline:
            self.adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
            self.adb("shell", "svc", "wifi", "disable")
            wait_for(lambda: self.adb("shell", "settings", "get", "global", "airplane_mode_on").strip() == "1" and self.adb("shell", "settings", "get", "global", "wifi_on").strip() == "0", "actual airplane mode with Wi-Fi disabled", 10)
        airplane = self.adb("shell", "settings", "get", "global", "airplane_mode_on").strip()
        wifi = self.adb("shell", "settings", "get", "global", "wifi_on").strip()
        self.save("offline-settings.json" if offline else "connectivity-settings.json", {"airplane_mode_on": airplane, "wifi_on": wifi, "recordAudioRevoked": True})
        self.open()
        # Revoking a runtime permission can kill the process. Re-establish an idle baseline.
        self.gear("Drive")
        self.command("baseline")
        self.gear("Park")
        if accept_via == "notification":
            self.adb("shell", "pm", "grant", "--user", self.user, PACKAGE, "android.permission.POST_NOTIFICATIONS")
        self.tap("demo")
        response = self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "offline demo response")
        if accept_via == "notification":
            self.command("capture-notification-action")
            self.command("send-captured-action")
            wait_for(lambda: f"NOTIFICATION_RESPONSE trip={response['tripId']}" in self.logs(), "valid notification PendingIntent delivered", 5)
        else:
            self.tap("accept")
        self.until_state(lambda state: state["state"] == "BRIEFING", "offline demo briefing")
        titles = []
        for expected_name in ("하늘", "도담", "새봄"):
            tree = self.hierarchy()
            text = " ".join(node.get("text", "") for node in tree.iter("node"))
            if not titles:
                self.save("accepted-ui.xml", ET.tostring(tree, encoding="unicode"))
                self.screenshot("accepted")
            require(expected_name in text, f"Missing pseudonymous card: {expected_name}")
            require(any(node.get("resource-id") == "dev.mobi:id/next" for node in tree.iter("node")), "Next control missing before briefing completion")
            titles.append(expected_name)
            self.tap("next")
        tree = self.hierarchy()
        require(any("브리핑이 끝났어요" in node.get("text", "") for node in tree.iter("node")), "Demo did not finish")
        state = self.state()
        require(not state["micReady"], "Demo enabled microphone")
        service = self.adb("shell", "dumpsys", "activity", "services", PACKAGE)
        require("types=40000080" not in service and "1073741952" not in service and "0x40000080" not in service, "Demo uses microphone FGS")
        self.save("demo-service.txt", service)
        self.save("demo-ui.xml", ET.tostring(tree, encoding="unicode"))
        self.screenshot("demo-complete")
        return {"acceptVia": accept_via, "airplane": airplane == "1", "microphoneGranted": False, "cards": titles, "completed": True}

    def boot(self):
        self.adb("shell", "pm", "grant", "--user", self.user, PACKAGE, "android.permission.POST_NOTIFICATIONS")
        self.open()  # Clear package stopped state before real BOOT_COMPLETED.
        self.gear("Park")
        self.command("reset-clock")
        self.adb("shell", "pm", "revoke", "--user", self.user, PACKAGE, "android.permission.RECORD_AUDIO")
        self.open()  # Permission revocation may have killed the process.
        self.adb("reboot")
        self.adb("wait-for-device", timeout=120)
        wait_for(lambda: self.adb("shell", "getprop", "sys.boot_completed").strip() == "1", "Android reboot", 120, 1)
        self.user = self.adb("shell", "am", "get-current-user").strip()
        self.connect_vc()
        # Do not launch Mobi Activity from this point until after assertions.
        wait_for(lambda: PACKAGE in self.adb("shell", "dumpsys", "activity", "services", PACKAGE), "boot service without opening app", 180)
        state = self.until_state(lambda state: state["gear"] == "PARK", "boot parked callback", 40)
        require(not state["micReady"], "Boot illegally enabled microphone")
        resumed = self.adb("shell", "dumpsys", "activity", "activities")
        require(not re.search(r"topResumedActivity[^\n]*dev\.mobi", resumed), "Mobi Activity was opened during boot test")
        service = self.adb("shell", "dumpsys", "activity", "services", PACKAGE)
        require("types=40000000" in service or "0x40000000" in service or "1073741824" in service, "Boot service type is not specialUse")
        require(len(re.findall(r"KNOCK trip=", self.logs())) == 1, "Boot did not emit exactly one cue")
        wait_for(lambda: len(re.findall(r"CUE_PLAY trip=", self.logs())) == 1, "actual boot cue playback", 5)
        self.save("boot-audio.txt", self.adb("shell", "dumpsys", "audio"))
        package_dump = self.adb("shell", "dumpsys", "package", PACKAGE)
        user_section = re.search(r"User " + re.escape(self.user) + r": ceDataInode=.*?(?=\n\s*User \d+:|\nQueries:|\Z)", package_dump, re.S)
        require(user_section is not None and "android.permission.RECORD_AUDIO: granted=false" in user_section.group(), "Boot RECORD_AUDIO permission is not proved denied for current user")
        self.save("boot-permission.txt", user_section.group())
        self.save("boot-service.txt", service)
        self.save("boot-activities.txt", resumed)
        self.gear("Park")
        duration = self.options.real_park_seconds
        require(duration >= 600, "Boot acceptance requires a real 600-second park")
        started = time.monotonic()
        next_report = 60
        while time.monotonic() - started < duration:
            time.sleep(max(0, min(5, duration - (time.monotonic() - started))))
            require(self.adb("shell", "pidof", PACKAGE).strip(), "Boot service died while parked")
            elapsed = time.monotonic() - started
            if elapsed >= next_report:
                print(f"boot: real parked {int(elapsed)}/{duration}s", flush=True)
                next_report += 60
        self.gear("Drive")
        require(len(re.findall(r"KNOCK trip=", self.logs())) == 1, "First departure duplicated boot cue")
        return {"realReboot": True, "activityOpened": False, "realParkSeconds": duration, "bootAndFirstDepartureKnocks": 1, "microphoneAtBoot": False}

    def microphone(self):
        # Verify real permission/FGS/background policy using an explicitly injected digital input.
        # Host earphones make acoustic loopback unsuitable for acceptance.
        self.adb("shell", "pm", "revoke", "--user", self.user, PACKAGE, "android.permission.RECORD_AUDIO")
        self.baseline();self.gear("Park")
        self.adb("shell", "pm", "grant", "--user", self.user, PACKAGE, "android.permission.POST_NOTIFICATIONS")
        self.open();self.tap("live")
        tree=self.hierarchy();self.save("runtime-permission-ui.xml",ET.tostring(tree,encoding="unicode"))
        allow=next((n for n in tree.iter("node") if n.get("resource-id")=="com.android.permissioncontroller:id/permission_allow_foreground_only_button" or n.get("resource-id")=="com.android.permissioncontroller:id/car_ui_list_item_title" and n.get("text") in {"앱 사용 중에만 허용","While using the app","Allow only while using the app"}),None)
        require(allow is not None,"Actual microphone permission control missing")
        x1,y1,x2,y2=map(int,re.findall(r"\d+",allow.get("bounds","")))
        self.adb("shell","input","tap",str((x1+x2)//2),str((y1+y2)//2))
        self.until_state(lambda state:state["micReady"] and not state["demo"],"real microphone FGS promotion")
        service=self.adb("shell","dumpsys","activity","services",PACKAGE)
        require("types=40000080" in service or "1073741952" in service,"Actual microphone FGS missing")
        self.save("microphone-service.txt",service)
        self.adb("emu","avd","hostmicoff")
        self.inject_voice("응")
        self.adb("shell","am","start","--user",self.user,"-n",NAVIGATION)
        nav=self.adb("shell","dumpsys","activity","activities")
        require(re.search(r"topResumedActivity[^\n]*ai\.umos\.maps",nav),"Navigation is not foreground")
        self.save("navigation-foreground.txt",nav)
        self.adb("logcat","-c");self.next_trip()
        wait_for(lambda:"VOICE_EVENT kind=confirm-result" in self.logs(),"background service digital voice response",12)
        log=self.logs()
        require("source=debug-wav" in log and "RECORD_RESULT voiced=true" in log,"Injected VAD did not produce actual PCM/WAV evidence")
        self.save("background-input.log",log)
        self.until_state(lambda state:state["voicePhase"]=="IDLE","background briefing complete")
        self.gear("Park");self.open();self.tap("demo")
        self.until_state(lambda state:state["demo"] and not state["micReady"],"demo drops microphone stage")
        self.until_state(lambda state:state["state"]=="AWAITING_RESPONSE","demo response")
        self.tap("decline");self.until_state(lambda state:state["state"]=="MUTED","demo decline")
        self.tap("live");self.until_state(lambda state:state["micReady"] and not state["demo"],"explicit live return")
        return {"runtimePermissionDialog":True,"realForegroundStage":True,"navigationForeground":True,"demoDemotion":True,"inputSource":"debug-wav","physicalMicrophoneAcceptance":False,"acousticLoopbackUsed":False}

    def lifetime(self):
        if not self.state()["micReady"]:
            microphone = self.microphone()
            self.results.append({"scenario": "microphone", "result": "PASS", **microphone})
            self.save("microphone.log", self.logs())
            self.save("results.json", self.results)
        self.baseline()
        self.next_trip()
        state = self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "live response")
        self.command("sentence", tripId=state["tripId"], sentence="됐어")
        before = self.until_state(lambda state: state["muted"], "persisted live mute")
        self.adb("shell", "am", "start", "--user", self.user, "-n", NAVIGATION)
        pid = self.adb("shell", "pidof", PACKAGE).strip()
        require(pid.isdigit(), "Expected one Mobi process")
        self.adb("shell", "run-as", PACKAGE, "--user", self.user, "kill", "-9", pid)
        new_pid = wait_for(lambda: (lambda value: value if value.isdigit() and value != pid else None)(self.adb("shell", "pidof", PACKAGE, check=False).strip()), "sticky PID recovery", 30)
        recovered = self.until_state(lambda state: state["muted"] and state["tripId"] == before["tripId"], "sticky mute recovery")
        require(recovered["micReady"], "Same-boot sticky microphone restore failed")
        self.adb("shell", "am", "force-stop", "--user", self.user, PACKAGE)
        # Force-stop is intentionally observed without broadcasts that could unstop it.
        started = time.monotonic()
        while time.monotonic() - started < 20:
            require(not self.adb("shell", "pidof", PACKAGE, check=False).strip(), "Force-stopped process resurrected")
            time.sleep(1)
        self.vc("/vehicle/gear?gear=Park")
        self.vc("/vehicle/gear?gear=Drive")
        require(not self.adb("shell", "pidof", PACKAGE, check=False).strip(), "Gear resurrected force-stopped app")
        self.save("force-stop-services.txt", self.adb("shell", "dumpsys", "activity", "services", PACKAGE))
        self.open()
        reopened = self.until_state(lambda state: state["muted"] and state["tripId"] == before["tripId"], "reopen mute recovery")
        return {"oldPid": int(pid), "stickyPid": int(new_pid), "stickyMute": recovered["muted"], "forceStopAutorestart": False, "reopenMute": reopened["muted"]}

    def fixture_request(self, path, value=None):
        body = json.dumps(value).encode() if value is not None else None
        request = urllib.request.Request("http://127.0.0.1:8788/__test/" + path, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.loads(response.read())

    def setup_fixture(self):
        try:
            self.fixture_request("state")
        except OSError:
            self.fixture_log = (self.evidence / "fixture.log").open("w")
            self.fixture = subprocess.Popen([sys.executable, str(APP / "e2e/fake_server.py")], cwd=APP, stdout=self.fixture_log, stderr=subprocess.STDOUT)
            def ready():
                try:
                    return self.fixture_request("state")
                except OSError:
                    return False
            wait_for(ready, "loopback fixture", 10)
        self.fixture_active = True
        self.adb("reverse", "tcp:8788", "tcp:8788")
        self.fixture_request("config", {})
        self.adb("shell", "cmd", "connectivity", "airplane-mode", "disable")
        self.adb("shell", "svc", "wifi", "enable")
        self.gear("Park")
        self.command("endpoint", url="http://127.0.0.1:8788")
        self.command("baseline")
        if not self.state()["hasToday"]:
            self.tap("connect")
        else:
            self.command("pair")
        pending_seen = False
        foreground_retry = False
        def paired_today():
            nonlocal pending_seen, foreground_retry
            state = self.state()
            pending_seen = pending_seen or state["pairing"] == "pending"
            if pending_seen and state["pairing"] == "idle" and not foreground_retry:
                # A cold Automotive boot may bring navigation to the foreground;
                # the app correctly cancels pairing when its Activity pauses.
                self.save("fixture-pairing-activity.txt", self.adb("shell", "dumpsys", "activity", "activities"))
                self.open()
                self.command("pair")
                foreground_retry = True
            return state if state["pairing"] == "paired" and state["hasToday"] else None
        wait_for(paired_today, "fixture pairing and today cache", 25)
        self.inject_voice(None)
        return self.state()

    def instrumentation(self):
        self.save("instrumentation.log", run([APP / "gradlew", "-p", APP, ":app:connectedDebugAndroidTest", "--offline", "--no-daemon"], timeout=240))
        self.install()
        self.setup_fixture()
        return {"connectedTests": "PASS"}

    def pairing(self):
        self.gear("Park")
        self.fixture_request("config", {"pairingPolls": 100})
        # Connect/retry is available through the parked service entry even for an already registered device.
        self.command("pair")
        self.until_state(lambda state: state["pairing"] == "pending", "visible pairing QR")
        self.screenshot("pairing-qr")
        env = dict(os.environ, CLANG_MODULE_CACHE_PATH=str(ROOT / ".context/voice-app/swift-module-cache"))
        result = subprocess.run(["swift", "-module-cache-path", str(ROOT / ".context/voice-app/swift-module-cache"), str(APP / "e2e/qr-check.swift"), str(self.evidence / "pairing-qr.png"), "http://127.0.0.1:8788/pair/" + "P" * 43], capture_output=True, text=True, env=env, timeout=60)
        self.save("qr-decoder.txt", result.stdout + result.stderr)
        require(result.returncode == 0 and "QR_MATCH=true" in result.stdout, "Independent QR decode failed")
        self.gear("Drive")
        require(self.node("pairing_qr") is None, "QR visible while driving")
        before = len(self.fixture_request("state")["requests"])
        time.sleep(2.2)
        require(len(self.fixture_request("state")["requests"]) == before, "Pairing poll continued while driving")
        self.gear("Park")
        self.fixture_request("config", {})
        self.command("pair")
        self.until_state(lambda state: state["pairing"] == "paired", "paired status")
        return {"qrDecoded": True, "pollStopsOnDrive": True, "paired": True}

    def activate_live(self):
        self.adb("shell", "pm", "grant", "--user", self.user, PACKAGE, "android.permission.POST_NOTIFICATIONS")
        self.gear("Park"); self.open()
        self.tap("live")
        if not self.state()["micReady"]:
            tree = self.hierarchy()
            allow = next((n for n in tree.iter("node") if n.get("resource-id") == "com.android.permissioncontroller:id/permission_allow_foreground_only_button" or n.get("resource-id") == "com.android.permissioncontroller:id/car_ui_list_item_title" and n.get("text") in {"앱 사용 중에만 허용", "While using the app", "Allow only while using the app"}), None)
            if allow is not None:
                x1, y1, x2, y2 = map(int, re.findall(r"\d+", allow.get("bounds", "")))
                self.adb("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        self.until_state(lambda state: state["micReady"] and not state["demo"], "explicit visible microphone activation")
        self.adb("emu", "avd", "hostmicoff")

    def voice_knock(self):
        # Keep the already-authorized mic stage across D, but use parked taps with host input disabled.
        # Actual voiced input is measured separately by voice-confirm/voice-turn.
        self.activate_live()
        self.inject_voice(None)
        rows = []
        for index in range(self.options.iterations):
            self.baseline()
            self.command("remaining", seconds=str([180, 600, 1800, "none"][index % 4]))
            self.adb("logcat", "-c")
            trip = self.next_trip()["tripId"]
            self.gear("Park")
            self.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "real cached knock ended")
            self.tap("accept")
            wait_for(lambda: "VOICE_EVENT kind=briefing-started" in self.logs(), "actual briefing playback start", 6)
            log = self.logs()
            knock = int(re.findall(r"KNOCK trip=.*?atMs=(\d+)", log)[-1])
            first = int(re.findall(r"VOICE_EVENT kind=knock-started.*?atMs=(\d+)", log)[-1])
            accept = int(re.findall(r"ACCEPT atMs=(\d+)", log)[-1])
            brief = int(re.findall(r"VOICE_EVENT kind=briefing-started.*?atMs=(\d+)", log)[-1])
            require(first-knock <= 1000 and brief-accept <= 1000, "Warm knock/accept start exceeded one second")
            self.save(f"knock-{index+1}.log", log)
            rows.append({"trip": trip, "knockStartMs": first-knock, "acceptStartMs": brief-accept})
            self.until_state(lambda state: state["voicePhase"] == "IDLE", "briefing complete")
        self.save("voice-knock-latencies.json", rows)
        return {"iterations": len(rows), "maxKnockMs": max(r["knockStartMs"] for r in rows), "maxAcceptMs": max(r["acceptStartMs"] for r in rows), "measurement": "MediaPlayer start plus framework playback evidence, fixture WAV"}

    def inject_voice(self, sentence):
        # Coordinator-approved digital input; None supplies silence for the parked tap alternative.
        key=hashlib.sha256((sentence or "silence").encode()).hexdigest()[:12]
        source=self.evidence/(key+".aiff")
        converted=self.evidence/(key+".wav")
        if sentence is None:
            pcm=bytes(256000)
        else:
            run(["say","-v","Yuna","-r","140","-o",source,sentence],timeout=10)
            run(["afconvert","-f","WAVE","-d","LEI16@16000","-c","1",source,converted],timeout=10)
            with wave.open(str(converted),"rb") as w:
                require(w.getnchannels()==1 and w.getsampwidth()==2 and w.getframerate()==16000,"Invalid synthesized test source")
                pcm=w.readframes(w.getnframes())
            pcm=b"\0"*(16000*2//3)+pcm+b"\0"*(16000*2)
        require(len(pcm)<=256000,"Synthetic input exceeds eight seconds")
        import io
        output=io.BytesIO()
        with wave.open(output,"wb") as w:
            w.setparams((1,2,16000,0,"NONE","not compressed"));w.writeframes(pcm)
        data=output.getvalue();converted.write_bytes(data)
        command=f"run-as {PACKAGE} --user {self.user} sh -c 'cat > files/voice-fixture.wav'"
        result=subprocess.run([str(ADB),"-s",self.serial,"shell","-T",command],input=data,capture_output=True,timeout=10)
        require(result.returncode==0,"Could not install private debug WAV")
        self.command("input-wav")
        self.until_state(lambda state:state["voicePhase"]=="IDLE","debug input configured")

    def voice_samples(self, mode):
        self.activate_live()
        rows=[]
        for index in range(self.options.iterations):
            self.fixture_request("config", {})
            self.baseline();self.gear("Park")
            self.inject_voice("응" if mode == "confirm" else "오늘 일정 알려줘")
            self.adb("logcat", "-c")
            if mode == "confirm":
                self.next_trip();self.gear("Park")
            else:
                self.tap("speak")
            self.until_state(lambda state: state["voicePhase"] == "LISTENING", "actual recorder listening")

            target = "confirm-result" if mode == "confirm" else "turn-started"
            wait_for(lambda: "VOICE_EVENT kind="+target in self.logs() or "VOICE_EVENT kind=deferred" in self.logs(), "voice server result", 10)
            log=self.logs();self.save(f"voice-{mode}-{index+1}.log",log)
            require("VOICE_EVENT kind="+target in log, "Actual recording did not produce the expected endpoint result; input/energy remains unverified")
            endpoint = re.findall(r"RECORD_RESULT voiced=true samples=(\d+) endpointMs=(\d+) lastVoiceMs=(\d+)",log)
            require(endpoint,"No actual voiced PCM sample evidence")
            _, detected, last = map(int,endpoint[-1])
            result=int(re.findall(r"VOICE_EVENT kind="+target+r".*?atMs=(\d+)",log)[-1])
            effects=re.findall(r"EFFECT_START atMs=(\d+)",log)
            require(effects and int(effects[-1])-detected<=300,"Local endpoint acknowledgement exceeded 300ms")
            require(result-last<=6000,"Whole voice response exceeded six seconds")
            require(not re.search(r"RECORD_START.*?AUDIO_START.*?RECORD_END",log,re.S),"Recording overlaps app playback")
            rows.append({"speechEndToResultMs":result-last,"vadMs":detected-last,"endpointToEffectMs":int(effects[-1])-detected})
            self.until_state(lambda state: state["voicePhase"] == "IDLE", "voice session finished", 10)
            require("VOICE_EVENT kind=complete" in self.logs(), "Playback failed instead of completing")
        values=sorted(r["speechEndToResultMs"] for r in rows)
        median=(values[(len(values)-1)//2]+values[len(values)//2])/2
        require(median <= (2000 if mode=="confirm" else 4200),"Fixture pipeline median exceeded target")
        self.save("voice-"+mode+"-latencies.json",rows)
        requests=self.fixture_request("state")["requests"]
        require(not any("/actions/" in r["path"] for r in requests),"Unexpected external action")
        return {"iterations":len(rows),"p50Ms":median,"maxMs":max(values),"source":"debug-wav (real VAD, no acoustic loopback)","physicalMicrophoneAcceptance":False,"server":"fake (recognition accuracy not claimed)"}

    def voice_confirm(self):
        return self.voice_samples("confirm")

    def voice_turn(self):
        return self.voice_samples("turn")

    def voice_deadline(self):
        self.activate_live();self.baseline();self.gear("Park")
        self.fixture_request("config",{"delay":8,"delayPath":"/v1/turns"})
        self.inject_voice("오늘 일정 알려줘")
        self.adb("logcat","-c");self.tap("speak")
        self.until_state(lambda state:state["voicePhase"]=="LISTENING","deadline capture")

        self.until_state(lambda state:state["state"]=="DEFERRED","six-second fallback",12)
        time.sleep(3)
        log=self.logs();self.save("late-response.log",log)
        require("VOICE_EVENT kind=turn-started" not in log,"Late response was played")
        match=re.findall(r"RECORD_RESULT voiced=true samples=\d+ endpointMs=\d+ lastVoiceMs=(\d+)",log)
        deferred=re.findall(r"VOICE_EVENT kind=deferred.*?atMs=(\d+)",log)
        require(match and deferred and 5800<=int(deferred[-1])-int(match[-1])<=6200,"Deadline was not tied to last voiced frame")
        self.fixture_request("config",{})
        return {"latePlayback":0,"fallbacks":len(deferred),"elapsedMs":int(deferred[-1])-int(match[-1])}

    def voice_navigation(self):
        self.activate_live();self.baseline();self.gear("Park")
        self.command("nav-start")
        wait_for(lambda:"NAV_ACTIVE active=true" in self.logs(),"actual Android playback callback usage12",5)
        self.command("test-knock")
        time.sleep(.3)
        require(self.state()["voicePhase"]!="SPEAKING","New playback started during guidance")
        self.command("nav-stop")
        wait_for(lambda:"NAV_ACTIVE active=false" in self.logs(),"navigation ended",5)
        # Interrupt a real MediaPlayer-backed knock with a second actual usage12 AudioTrack.
        self.adb("logcat","-c")
        self.command("test-knock")
        wait_for(lambda:"VOICE_EVENT kind=knock-started" in self.logs(),"actual assistant playback",5)
        self.adb("logcat","-c");self.command("nav-start")
        wait_for(lambda:"NAV_ACTIVE active=true" in self.logs(),"navigation pause",5)
        log=self.logs();self.save("navigation.log",log)
        self.save("navigation-audio.txt",self.adb("shell","dumpsys","audio"))
        paused=re.findall(r"AUDIO_PAUSE atMs=(\d+)",log)
        nav=re.findall(r"NAV_ACTIVE active=true atMs=(\d+)",log)
        require(paused and nav and abs(int(paused[0])-int(nav[0]))<=300,"Callback pause exceeds 300ms")
        self.command("nav-stop")
        actual=False
        if self.options.real_guidance:
            self.command("remaining-live")
            # Use the existing installed spike UI as the route fixture. Production NaviSource stays read-only.
            self.adb("shell","am","start","--user",self.user,"-n","dev.mobi.spike/.MainActivity")
            tree=self.hierarchy()
            init=next((n for n in tree.iter("node") if n.get("text")=="P4 Navi init"),None)
            route=next((n for n in tree.iter("node") if n.get("text","").startswith("P4 requestRoute")),None)
            require(init is not None and route is not None,"Installed route fixture controls missing")
            def click_node(node):
                x1,y1,x2,y2=map(int,re.findall(r"\d+",node.get("bounds","")))
                self.adb("shell","input","tap",str((x1+x2)//2),str((y1+y2)//2))
            click_node(init);time.sleep(.6)
            self.fixture_request("config",{"briefingSeconds":23})
            self.baseline();self.gear("Park");self.open()
            self.adb("logcat","-c");self.command("test-knock")
            self.until_state(lambda state:state["state"]=="AWAITING_RESPONSE","ready real-navigation briefing")
            self.tap("accept")
            wait_for(lambda:"VOICE_EVENT kind=briefing-started" in self.logs(),"long actual MediaPlayer briefing",6)
            self.adb("shell","am","start","--user",self.user,"-f","0x20020000","-n","dev.mobi.spike/.MainActivity")
            time.sleep(.5)
            tree=self.hierarchy()
            route=next((n for n in tree.iter("node") if n.get("text","").startswith("P4 requestRoute")),None)
            require(route is not None,"Route fixture visible after returning to its window")
            click_node(route)
            self.save("route-fixture.log",self.adb("logcat","-d","-s","MobiSpike:I","*:S"))
            def active_navigation():
                pid=self.adb("shell","pidof","ai.umos.maps.android.navigation.app",check=False).strip()
                if not pid.isdigit():return False
                dump=self.adb("shell","dumpsys","audio")
                lines=[line for line in dump.splitlines() if "state:started" in line and "USAGE_ASSISTANCE_NAVIGATION_GUIDANCE" in line and ("/"+pid) in line]
                if lines:self.save("actual-navigation-audio.txt",dump);return True
                return False
            wait_for(active_navigation,"actual maps PID active NAVIGATION_GUIDANCE",20,.1)
            actual=True
            self.save("actual-navigation.log",self.logs())
            require("NAV_ACTIVE active=true" in self.logs(),"Actual navigation did not reach app callback")
            self.save("actual-navigation-state.json",self.state())
            self.fixture_request("config",{})
        return {"syntheticCallback":True,"actualNavigation":actual,"callbackPauseMs":abs(int(paused[0])-int(nav[0])),"literalZeroOverlap":"UNVERIFIED; reactive callbacks may overlap"}

    def voice_offline(self):
        from fake_server import today
        expected = today(production_knock=True)["knock"]["offline"]
        require("?" not in expected["text"] and "들을까요" not in expected["text"], "Offline asset asks a question")
        self.fixture_request("config", {"productionKnock": True})
        self.command("endpoint", url="http://127.0.0.1:8788")
        self.open()
        self.command("pair")  # A successful pairing explicitly refreshes /v1/today.

        def production_manifests():
            paths = self.adb("shell", "run-as", PACKAGE, "--user", self.user,
                             "find", "no_backup/today", "-name", "bundle.json", check=False).splitlines()
            found = []
            for path in paths:
                require(re.fullmatch(r"no_backup/today/[0-9a-f]{64}/bundle\.json", path), "Unexpected cache path")
                raw = self.adb("exec-out", "run-as", PACKAGE, "--user", self.user, "cat", path)
                manifest = json.loads(raw)
                if manifest["knock"]["offline"]["sha256"] == expected["sha256"]:
                    found.append(path)
            return found

        manifests = wait_for(production_manifests, "production informational WAV cached", 20)
        self.baseline()
        self.gear("Park")
        self.adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
        self.adb("shell", "svc", "wifi", "disable")
        wait_for(lambda: not self.state()["online"], "app observes offline connectivity", 10)
        samples = []
        try:
            for cached in (True, False):
                if not cached:
                    self.baseline()
                    self.gear("Park")
                    for path in manifests:
                        self.adb("shell", "run-as", PACKAGE, "--user", self.user, "rm", "-f", path)
                    require(not production_manifests(), "Usable cache manifest still exists")
                self.command("advance", millis=600000)
                before = len(self.fixture_request("state")["requests"])
                self.adb("logcat", "-c")
                state = self.gear("Drive")
                trip = state["tripId"]
                source = state["sourceNs"]
                require(source > 0, "Actual departure timestamp unavailable")
                if cached:
                    def first_start():
                        values = re.findall(r"CUE_PLAY trip=" + str(trip) + r" atNs=(\d+)", self.logs())
                        return min(map(int, values)) if values else None
                    started = wait_for(first_start, "cached offline playback begins", 5, .1)
                    latency = (started - source) / 1000000
                    require(0 <= latency <= 5000, f"Departure-to-playback {latency:.2f}ms exceeds 5000ms")
                    # Production speech lasts >6s: completion is separate from the start SLA.
                    wait_for(lambda: "VOICE_EVENT kind=complete" in self.logs(), "offline WAV completes", 12)
                else:
                    self.until_state(lambda value: value["state"] == "DEFERRED" and not value["hasToday"], "missing cache silently defers")
                    time.sleep(5.25)
                    latency = None
                log = self.logs()
                starts = re.findall(r"CUE_PLAY trip=" + str(trip) + r" atNs=(\d+)", log)
                require(len(starts) == (1 if cached else 0), "Unexpected offline playback count")
                require(log.count("AUDIO_START") == (1 if cached else 0), "Unexpected extra/error audio playback")
                require("RECORD_START" not in log, "Offline departure started recording")
                require(not any(value in log for value in ("failure-started", "briefing-started", "turn-started")), "Offline departure spoke a response/error")
                require(len(self.fixture_request("state")["requests"]) == before, "Offline departure sent network requests")
                require(not self.state()["online"], "Connectivity returned during offline acceptance")
                name = "cached" if cached else "no-cache"
                self.save("offline-" + name + ".log", log)
                samples.append({"case": name, "tripId": trip, "departureSourceNs": source,
                                "playbackStartMs": latency, "playbacks": len(starts), "networkRequests": 0,
                                "recordings": 0, "errorSpeech": 0})
            self.save("offline-departures.json", samples)
            return {"cases": samples, "productionOfflineSha256": expected["sha256"],
                    "maxPlaybackStartMs": samples[0]["playbackStartMs"], "physicalFirstSound": "UNVERIFIED: emulator playback callback"}
        finally:
            self.adb("shell", "cmd", "connectivity", "airplane-mode", "disable")
            self.adb("shell", "svc", "wifi", "enable")
            self.fixture_request("config", {})

    def voice_privacy(self):
        self.command("input-reset")
        self.command("baseline")
        time.sleep(.3)
        log=self.logs()
        from fake_server import TOKEN
        require(TOKEN not in log and "NEVER_SPEAK_FIXTURE" not in log and "가상 일정 1" not in log,"Private fixture marker leaked into logs")
        files=self.adb("shell","run-as",PACKAGE,"--user",self.user,"find","files/device-auth","cache/voice-output","-type","f",check=False).splitlines()
        leaked=0;temporary=0
        for path in files:
            if path.startswith("cache/voice-output/"): temporary+=1
            if path.startswith("files/device-auth/"):
                data=self.adb("exec-out","run-as",PACKAGE,"--user",self.user,"cat",path,binary=True)
                leaked+=int(TOKEN.encode() in data)
        require(leaked==0 and temporary==0,"Token or temporary audio retained")
        return {"plaintextTokenFiles":leaked,"temporaryAudioFiles":temporary,"logMarkers":0}

    def clean(self):
        # Cleanup must not turn a failed scenario into a success.
        with_errors = []
        for command in ("nav-stop", "disarm-capture", "input-reset", "reset-clock", "endpoint"):
            try:
                if self.adb("shell", "pidof", PACKAGE, check=False).strip():
                    self.command(command)
            except Exception as failure:
                with_errors.append(str(failure))
        try:
            if self.original_gear:
                self.vc("/vehicle/gear?gear=" + self.original_gear)
            self.adb("shell", "cmd", "connectivity", "airplane-mode", "enable" if self.original_airplane == "1" else "disable")
            self.adb("shell", "svc", "wifi", "enable" if self.original_wifi == "1" else "disable")
            self.adb("emu", "avd", "hostmicoff")
        except Exception as failure:
            with_errors.append(str(failure))
        self.stop_heartbeat.set()
        if self.heartbeat_thread:
            self.heartbeat_thread.join(timeout=4)
        self.adb("forward", "--remove", "tcp:8088", check=False)
        self.adb("reverse", "--remove", "tcp:8788", check=False)
        if self.fixture:
            self.fixture.terminate()
            self.fixture.wait(timeout=5)
        if self.fixture_log:
            self.fixture_log.close()
        self.save("cleanup.json", {"errors": with_errors})
        if with_errors:
            raise RuntimeError("Cleanup failed: " + "; ".join(with_errors))

    def execute(self):
        scenario = self.options.scenario
        try:
            if scenario == "install":
                result = self.install()
                self.results.append({"scenario": scenario, "result": "PASS", **result})
            else:
                self.connect_vc()
                self.open()
                self.setup_fixture()
                initial = self.state()
                self.original_gear = {"PARK": "Park", "DRIVE": "Drive"}.get(initial["gear"])
                names = ["trip", "dialog", "driving", "boot-buttons", "demo-notification", "demo", "boot", "microphone", "lifetime", "pairing", "voice-knock", "voice-confirm", "voice-turn", "voice-deadline", "voice-navigation", "voice-offline", "voice-privacy"] if scenario == "all" else [scenario]
                for name in names:
                    self.adb("shell", "cmd", "connectivity", "airplane-mode", "disable")
                    self.adb("shell", "svc", "wifi", "enable")
                    self.adb("logcat", "-c")
                    method = {"boot-buttons": self.boot_buttons, "demo": self.demo_case, "demo-notification": self.demo_notification}.get(name) or getattr(self, name.replace("-", "_"))
                    result = method()
                    self.results.append({"scenario": name, "result": "PASS", **result})
                    self.save(name + ".log", self.logs())
                    self.save("results.json", self.results)
                    print(json.dumps(self.results[-1], ensure_ascii=False), flush=True)
            self.save("results.json", self.results)
        except Exception as failure:
            self.results.append({"scenario": scenario, "result": "FAIL", "reason": str(failure)})
            self.save("results.json", self.results)
            self.save("failure.log", self.logs())
            self.save("failure-audio.txt", self.adb("shell", "dumpsys", "audio", check=False))
            self.save("failure-media.txt", self.adb("shell", "dumpsys", "media.player", check=False))
            self.save("failure-activity.txt", self.adb("shell", "dumpsys", "activity", "activities", check=False))
            self.save("failure.png", self.adb("exec-out", "screencap", "-p", binary=True, check=False))
            self.save("failure-native.log", self.adb("logcat", "-d", "-s", "MediaPlayer:D", "MediaPlayerNative:D", "NuPlayerDriver:D", "AudioTrack:W", "AndroidRuntime:E", "*:S"))
            if self.fixture_active:
                self.save("failure-fixture.json", self.fixture_request("state"))
            raise
        finally:
            self.clean()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=["install", "trip", "dialog", "driving", "boot-buttons", "demo-notification", "demo", "boot", "microphone", "lifetime", "pairing", "instrumentation", "voice-knock", "voice-confirm", "voice-turn", "voice-deadline", "voice-navigation", "voice-offline", "voice-privacy", "all", "verify-artifacts"])
    parser.add_argument("--real-guidance", action="store_true", help="Require actual installed navigation guidance in addition to debug usage12")
    parser.add_argument("--serial")
    parser.add_argument("--evidence-root", help="Override the default evidence directory")
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--max-hidden-ms", type=float, default=200)
    parser.add_argument("--real-park-seconds", type=int, default=600)
    parser.add_argument("--capture-seconds", type=int, default=6)
    parser.add_argument("--airplane", action="store_true", help="Demo always enforces airplane mode")
    parser.add_argument("--revoke-microphone", action="store_true", help="Demo always revokes microphone")
    options = parser.parse_args()
    require(options.capture_seconds == 6, "The approved capture probe measures exactly six seconds")
    require(options.iterations > 0, "Iterations must be positive")
    if options.scenario == "verify-artifacts":
        verify_artifacts()
    else:
        Harness(options).execute()


if __name__ == "__main__":
    main()
