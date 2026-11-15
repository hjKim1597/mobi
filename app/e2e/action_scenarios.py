"""UI-level action scenarios used by run.py after the API fixture is paired."""
import io
import json
from decimal import Decimal
import re
import subprocess
import time
import wave
from pathlib import Path


PRIVATE_MARKERS = ("sender@example.invalid", "회의 시간 확인", "해당 시간 가능합니다")
APP = Path(__file__).resolve().parents[1]
SDK = Path(next(line.split("=", 1)[1] for line in (APP / "local.properties").read_text().splitlines()
               if line.startswith("sdk.dir=")))
ADB = SDK / "platform-tools/adb"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def _stage(harness, expected, message, timeout=20):
    return harness.until_state(lambda state: state.get("actionStage") == expected, message, timeout)


def _inject_silence_without_rebinding(harness):
    """Replace the debug WAV contents between captures without resetting VoiceInput."""
    data = io.BytesIO()
    with wave.open(data, "wb") as source:
        source.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        source.writeframes(bytes(16000 * 2 * 2))
    _write_wav_without_rebinding(harness, data.getvalue())


def _write_wav_without_rebinding(harness, data):
    command = f"run-as dev.mobi --user {harness.user} sh -c 'cat > files/voice-fixture.wav'"
    result = subprocess.run([str(ADB), "-s", harness.serial, "shell", "-T", command], input=data,
                            capture_output=True, timeout=10)
    require(result.returncode == 0, "Could not replace the private debug WAV")


def _inject_phrase_without_rebinding(harness, phrase):
    source = harness.evidence / "hold-cancel.aiff"
    converted = harness.evidence / "hold-cancel-voice.wav"
    subprocess.run(["say", "-v", "Yuna", "-r", "140", "-o", str(source), phrase],
                   check=True, capture_output=True, timeout=10)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(source), str(converted)],
                   check=True, capture_output=True, timeout=10)
    with wave.open(str(converted), "rb") as recording:
        require(recording.getframerate() == 16000 and recording.getnchannels() == 1 and recording.getsampwidth() == 2,
                "Generated hold-cancel fixture has the wrong PCM format")
        pcm = recording.readframes(recording.getnframes())
    data = io.BytesIO()
    with wave.open(data, "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(bytes(16000 * 2 // 3) + pcm + bytes(16000 * 2))
    _write_wav_without_rebinding(harness, data.getvalue())


def _assert_hold_window(harness):
    actions = harness.fixture_request("state").get("actions", [])
    holding = next((action for action in actions if action["status"] == "holding"), None)
    require(holding is not None and holding["approvedAt"] is not None and holding["executeAt"] is not None,
            "Fixture did not record a private-safe approval/hold timestamp")
    require(holding["executeAt"] - holding["approvedAt"] >= 12000, "Hold starts less than 12 seconds after approval")
    return holding


def _assert_private_content_hidden(harness):
    tree = harness.hierarchy()
    content = " ".join(node.get("text", "") + " " + node.get("content-desc", "") for node in tree.iter("node"))
    require(not any(marker in content for marker in PRIVATE_MARKERS), "Driving UI exposed private action content")
    require(not any(node.get("resource-id", "").startswith("dev.mobi:id/action_") for node in tree.iter("node")),
            "Driving UI retained action controls or accessibility nodes")


def _drive_during_action_and_measure(harness):
    state = harness.gear("Drive")
    source = state.get("sourceNs")
    require(isinstance(source, int) and source > 0, "D transition has no monotonic source timestamp")
    def hidden_draw():
        values = [int(draw) for src, draw in re.findall(r"DRAW_HIDDEN sourceNs=(\d+) drawNs=(\d+)", harness.logs())
                  if int(src) == source and int(draw) >= source]
        return min(values) if values else None
    deadline = time.monotonic() + 5
    draw = None
    while time.monotonic() < deadline and draw is None:
        draw = hidden_draw()
        if draw is None:
            time.sleep(.1)
    require(draw is not None, "No first hidden action frame was recorded")
    elapsed = (draw - source) / 1_000_000
    require(elapsed <= 200, "Action screen hide exceeded 200ms after D")
    _assert_private_content_hidden(harness)
    harness.screenshot("driving")
    return elapsed


def _prepare_mail_offer(harness, scenario, wav_text):
    harness.activate_live()
    harness.fixture_request("config", {"actionScenario": scenario, "delay": 1.0,
                                        "delayPath": "/v1/actions/proposals"})
    harness.baseline()
    harness.gear("Park")
    harness.inject_voice(wav_text)
    harness.command("action-scan")
    _stage(harness, "OFFER", "mail action offer")


def _finish_approved_action(harness):
    _stage(harness, "HOLDING", "approved action hold")
    _assert_hold_window(harness)
    result = _stage(harness, "RESULT", "action terminal result", 25)
    require(result.get("actionOutcome") == "succeeded", "Action did not reach a success result")
    return result


def reply(harness):
    _prepare_mail_offer(harness, "reply", "해당 시간 가능합니다")
    harness.tap("action_reply")
    _stage(harness, "DICTATING", "reply dictation")
    # ActionSession enters PROCESSING immediately after its one real injected-WAV capture.
    _stage(harness, "PROCESSING", "reply proposal request")
    _inject_silence_without_rebinding(harness)
    _stage(harness, "AWAITING_APPROVAL", "complete reply readback")
    harness.tap("action_approve")
    _stage(harness, "HOLDING", "approved reply hold")
    _assert_hold_window(harness)
    hidden_ms = _drive_during_action_and_measure(harness)
    result = _stage(harness, "RESULT", "reply terminal result", 25)
    require(result.get("actionOutcome") == "succeeded", "Reply did not reach a successful terminal status")
    requests = harness.fixture_request("state")["requests"]
    require(any(r["path"] == "/v1/mail/scan" for r in requests), "Reply scenario did not scan mail")
    require(any(r["path"] == "/v1/actions/proposals" for r in requests), "Reply proposal missing")
    require(any(r["path"].endswith("/approve") for r in requests), "Reply approve request missing")
    require(any(r["method"] == "GET" and r["path"].startswith("/v1/actions/") and r["path"].count("/") == 3
                for r in requests), "Reply action status was not checked")
    require(any(item["status"] == "succeeded" for item in harness.fixture_request("state")["actions"]),
            "Fake fixture did not reach a successful terminal status")
    require(sum(r["method"] == "POST" and r["path"].endswith("/approve") for r in requests) == 1,
            "Reply approval was posted more than once")
    return {"flow": "reply", "proposal": True, "holdAtLeast12Seconds": True,
            "terminal": "succeeded", "privateContentHiddenDuringDrive": True, "hiddenMs": hidden_ms}


def calendar_from_mail(harness):
    _prepare_mail_offer(harness, "calendar_mail", "해당 시간 가능합니다")
    harness.tap("action_calendar")
    _stage(harness, "PROCESSING", "calendar-from-mail proposal")
    _inject_silence_without_rebinding(harness)
    _stage(harness, "AWAITING_APPROVAL", "complete calendar readback")
    harness.tap("action_approve")
    _finish_approved_action(harness)
    requests = harness.fixture_request("state")["requests"]
    require(any(r["path"] == "/v1/mail/scan" for r in requests), "Calendar-from-mail did not scan mail")
    require(any(r["path"] == "/v1/actions/proposals" for r in requests), "Calendar-from-mail proposal missing")
    return {"flow": "calendar_from_mail", "proposal": True, "holdAtLeast12Seconds": True, "terminal": "succeeded"}


def calendar_by_voice(harness):
    harness.activate_live()
    harness.fixture_request("config", {"actionScenario": "calendar_voice",
                                        "transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘"})
    harness.baseline()
    harness.gear("Park")
    harness.inject_voice("내일 오후 두 시 팀 회의 일정 추가해 줘")
    harness.fixture_request("config", {"actionScenario": "calendar_voice", "transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘",
                                        "delay": 1.0, "delayPath": "/v1/turns"})
    harness.adb("logcat", "-c")
    harness.tap("speak")
    harness.until_state(lambda state: state.get("voicePhase") == "THINKING" and "RECORD_RESULT voiced=true" in harness.logs(), "voice calendar turn request")
    _inject_silence_without_rebinding(harness)
    _stage(harness, "READBACK", "calendar action readback fetched after pending turn", 25)
    _stage(harness, "AWAITING_APPROVAL", "complete voice calendar readback")
    harness.tap("action_approve")
    _finish_approved_action(harness)
    requests = harness.fixture_request("state")["requests"]
    turn_requests = [r for r in requests if r["path"] == "/v1/turns"]
    require(len(turn_requests) == 1, "Voice calendar scenario must use /turns exactly once")
    require(not any(r["path"] == "/v1/actions/proposals" for r in requests),
            "actionProposal from /turns was redundantly proposed")
    readbacks = [r for r in requests if r["path"].endswith("/readback")]
    require(len(readbacks) == 1, "Voice calendar must fetch readback exactly once")
    approvals = [r for r in requests if r["method"] == "POST" and r["path"].endswith("/approve")]
    require(len(approvals) == 1, "Voice calendar approval must be posted exactly once")
    readback_id = readbacks[0]["path"].split("/")[3]
    approval_id = approvals[0]["path"].split("/")[3]
    require(readback_id == approval_id, "Readback and approval used different action IDs")
    action_requests = [r for r in requests if r["path"].startswith("/v1/actions/")]
    allowed_action_paths = {"/v1/actions/" + readback_id,
                             readbacks[0]["path"], approvals[0]["path"]}
    require(all(r["path"] in allowed_action_paths for r in action_requests),
            "Voice calendar flow made an unexpected action request")
    terminal_actions = harness.fixture_request("state")["actions"]
    action = next((item for item in terminal_actions if item["actionId"] == readback_id), None)
    require(action is not None and action["status"] == "succeeded",
            "Voice calendar action did not reach succeeded")
    return {"flow": "calendar_by_voice", "actionProposalPendingThenReadback": True,
            "holdAtLeast12Seconds": True, "terminal": "succeeded"}


def cancel_in_hold(harness):
    _prepare_mail_offer(harness, "cancel_hold", "해당 시간 가능합니다")
    harness.tap("action_reply")
    _stage(harness, "PROCESSING", "cancel scenario proposal")
    _inject_silence_without_rebinding(harness)
    _stage(harness, "AWAITING_APPROVAL", "complete cancel scenario readback")
    harness.tap("action_approve")
    _stage(harness, "HOLDING", "cancel scenario holding")
    _assert_hold_window(harness)
    # The already configured reader sees this speech when the hold listener begins.
    _inject_phrase_without_rebinding(harness, "취소")
    result = _stage(harness, "RESULT", "speech-onset cancellation result")
    require(result.get("actionOutcome") == "cancelled", "Speech-onset cancel did not reach cancelled result")
    paths = [r["path"] for r in harness.fixture_request("state")["requests"]]
    cancel_index = next(i for i, path in enumerate(paths) if path.endswith("/cancel"))
    transcription = [i for i, path in enumerate(paths) if path == "/v1/turns"]
    require(not transcription or cancel_index < min(transcription), "Speech onset was transcribed before cancellation request")
    return {"flow": "cancel_in_hold", "cancelBeforeTranscription": True, "terminal": "cancelled"}


def demo_hold_windows(log):
    """Milliseconds between actual hold-speech completion and first terminal status poll."""
    windows = []
    speaking = False
    completed_at = None
    for match in re.finditer(r"^\s*(\d+\.\d+).*?\bSTATE (\{[^\n]+\})", log, re.M):
        value = json.loads(match.group(2))
        if not value.get("demo"):
            continue
        stage, phase = value.get("actionStage"), value.get("voicePhase")
        timestamp = Decimal(match.group(1))
        if stage == "HOLDING":
            if phase == "SPEAKING":
                speaking = True
            elif phase == "IDLE" and speaking and completed_at is None:
                completed_at = timestamp
        elif stage == "PROCESSING" and completed_at is not None:
            windows.append(int((timestamp-completed_at)*1000))
            speaking, completed_at = False, None
        elif stage in {"CANCELLING", "RESULT", "UNKNOWN"}:
            speaking, completed_at = False, None
    return windows


def demo_offline(harness):
    harness.fixture_request("reset", {})
    harness.gear("Park")
    harness.adb("shell", "pm", "revoke", "--user", harness.user, "dev.mobi", "android.permission.RECORD_AUDIO")
    harness.open()
    harness.gear("Drive")
    harness.command("baseline")
    harness.gear("Park")
    harness.adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
    harness.adb("shell", "svc", "wifi", "disable")
    harness.tap("demo")
    harness.until_state(lambda state: state["state"] == "AWAITING_RESPONSE", "parked demo entry")
    harness.tap("accept")
    harness.until_state(lambda state: state["state"] == "BRIEFING", "offline demo briefing")
    for expected_name in ("하늘", "도담", "새봄"):
        text = " ".join(node.get("text", "") for node in harness.hierarchy().iter("node"))
        require(expected_name in text, "Offline demo card missing: " + expected_name)
        harness.tap("next")
    harness.tap("action_demo_mail")
    _stage(harness, "OFFER", "local virtual mail offer")
    card = " ".join(node.get("text", "") + " " + node.get("content-desc", "") for node in harness.hierarchy().iter("node"))
    require("데모" in card, "Demo mail is not labeled as a demo")
    harness.tap("action_reply")
    _stage(harness, "DICTATING", "local demo reply prompt")
    harness.tap("action_demo_dictate")
    _stage(harness, "AWAITING_APPROVAL", "local demo reply readback", 45)
    approval_started = time.monotonic()
    harness.tap("action_approve")
    _stage(harness, "HOLDING", "local demo reply hold")
    reply_result = _stage(harness, "RESULT", "local demo reply result", 25)
    require(time.monotonic() - approval_started >= 12, "Local demo reply hold completed before 12 seconds")
    require(reply_result.get("actionOutcome") == "succeeded", "Local demo reply did not succeed")
    result_text = " ".join(node.get("text", "") for node in harness.hierarchy().iter("node"))
    require("실제 메일은 보내지 않았어요" in result_text, "Demo result omitted the no-real-mail disclosure")
    _stage(harness, "OFFER", "mail calendar follow-up offer")
    harness.tap("action_calendar")
    _stage(harness, "AWAITING_APPROVAL", "local demo calendar readback", 45)
    approval_started = time.monotonic()
    harness.tap("action_approve")
    _stage(harness, "HOLDING", "local demo calendar hold")
    calendar_result = _stage(harness, "RESULT", "local demo calendar result", 25)
    require(time.monotonic() - approval_started >= 12, "Local demo calendar hold completed before 12 seconds")
    require(calendar_result.get("actionOutcome") == "succeeded", "Local demo calendar did not succeed")
    calendar_text = " ".join(node.get("text", "") for node in harness.hierarchy().iter("node"))
    require("실제 일정은 만들지 않았어요" in calendar_text, "Demo result omitted no-real-calendar disclosure")
    harness.tap("action_demo_voice")
    _stage(harness, "AWAITING_APPROVAL", "offline direct calendar request readback", 45)
    harness.tap("action_approve")
    _stage(harness, "HOLDING", "offline direct calendar cancellable hold")
    harness.tap("action_cancel")
    cancelled = _stage(harness, "RESULT", "offline demo hold cancellation")
    require(cancelled.get("actionOutcome") == "cancelled", "Offline direct calendar did not cancel")
    require(not harness.fixture_request("state")["requests"], "Offline demo made an API request")
    require("RECORD_START" not in harness.logs(), "Offline demo recorded microphone input")
    device_log = harness.adb("logcat", "-d", "-v", "epoch", "-s", "Mobi:I", "*:S")
    windows = demo_hold_windows(device_log)
    require(len(windows) == 2 and min(windows) >= 10000, "Demo did not keep ten seconds after actual hold playback")
    harness.save("post-clip-cancel-windows.json", {"milliseconds": windows})
    return {"postClipCancelWindowMs": windows, "flow": "demo_offline", "networkRequests": 0, "virtualLabel": True,
            "noRealMailDisclosure": True, "localActionResult": True, "directCalendarCancelled": True}


SCENARIOS = {
    "action-reply": reply,
    "action-calendar-mail": calendar_from_mail,
    "action-calendar-voice": calendar_by_voice,
    "action-cancel-hold": cancel_in_hold,
    "action-demo-offline": demo_offline,
}
