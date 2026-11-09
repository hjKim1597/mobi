#!/usr/bin/env python3
"""Loopback-only contract fixture. No cloud, OAuth, AI or personal data."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
from pathlib import Path
import re
import struct
import threading
import time
import unicodedata
import uuid
import wave

DEVICE_ID = "11111111-1111-4111-8111-111111111111"
TOKEN = DEVICE_ID + "." + "a" * 64
CODE = "P" * 43
LOCK = threading.Lock()
CONFIG = {}
COUNTS = []
POLLS = 0
ACTIONS = {}
REQUESTS_BY_ID = {}


def wav_bytes(seconds=.8, rate=44100):
    data = io.BytesIO()
    with wave.open(data, "wb") as w:
        w.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        w.writeframes(b"".join(struct.pack("<h", int(math.sin(2 * math.pi * 440 * i / rate) * 1500) if i < rate * .2 else 0) for i in range(int(rate * seconds))))
    return data.getvalue()


WAV = wav_bytes()
AUDIO = {"data": base64.b64encode(WAV).decode(), "mimeType": "audio/wav"}
ACTION_WAV = wav_bytes(rate=16000)
ACTION_AUDIO = {"data": base64.b64encode(ACTION_WAV).decode(), "mimeType": "audio/wav"}
# Match the live contract: execution follows the hold announcement and 14.5-second margin.
HOLD_AUDIO_MS = 3000
HOLD_AUDIO = {"data": base64.b64encode(wav_bytes(HOLD_AUDIO_MS / 1000)).decode(), "mimeType": "audio/wav"}


def today(production_knock=False):
    day = datetime.now(timezone(timedelta(hours=9))).date().isoformat()
    events = [{"id": f"fixture-{i}", "title": f"가상 일정 {i}",
               "start": {"dateTime": f"{day}T{9+i:02}:00:00+09:00"},
               "end": {"dateTime": f"{day}T{10+i:02}:00:00+09:00"}} for i in range(3)]
    def spoken(text):
        return {"text": text, "audio": dict(AUDIO), "sha256": hashlib.sha256(WAV).hexdigest()}
    value = {"date": day, "timeZone": "Asia/Seoul", "events": events, "future": True,
            "knock": {"version": "knock-v1", "date": day, "timeZone": "Asia/Seoul", "eventCount": 3,
                      "online": spoken("오늘 일정이 여러 개 있어요. 들을까요?"),
                      "offline": spoken("오늘 일정이 여러 개 있어요. 정차하면 카드로 보여드릴게요.")}}
    if production_knock:
        source = (Path(__file__).resolve().parents[2] / "server/src/knock-audio.ts").read_text()
        assets = json.loads(source.split(" = ", 1)[1].strip().removesuffix(";"))
        for mode in ("online", "offline"):
            asset = assets["many-" + mode]
            value["knock"][mode] = {"text": asset["text"], "sha256": asset["sha256"],
                                    "audio": {"data": asset["data"], "mimeType": "audio/wav"}}
    return value


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_):
        pass

    def answer(self, status, value, config=None):
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        config = config or {}
        if config.get("badAudio"):
            raw = raw.replace(AUDIO["data"].encode(), b"AAAA")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            if config.get("drip"):
                for b in raw:
                    self.wfile.write(bytes([b])); self.wfile.flush(); time.sleep(.1)
            else:
                self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    @staticmethod
    def spoken(text, audio=None):
        return {"text": text, "audio": dict(audio or AUDIO)}

    def candidate(self, config):
        if config.get("sensitiveMail"):
            return {"candidateId": "fixture-mail-sensitive", "sensitive": True, "canReply": False,
                    "canAddCalendar": False, "sentences": [self.spoken("민감한 내용으로 보여 정차 후 확인해 주세요.")],
                    "replyPromptSentences": [], "display": {"sender": "가상 담당자"}}
        return {"candidateId": "fixture-mail-1", "sensitive": False, "canReply": True,
                "canAddCalendar": True,
                "sentences": [self.spoken("회신이 필요해 보이는 메일이 있어요. 가상 담당자 님이 회의 시간 확인을 부탁했어요. 회신 내용을 작성할까요?")],
                "replyPromptSentences": [self.spoken("답장 내용을 짧게 말씀해 주세요.")],
                "calendarOfferSentences": [self.spoken("메일에 2026년 11월 10일 오후 두 시 회의가 있어요. 일정 내용을 확인할까요?")],
                "display": {"sender": "가상 담당자 <sender@example.invalid>", "subject": "회의 시간 확인",
                            "summary": "11월 10일 오후 두 시부터 두 시 반 회의가 가능한지 회신 부탁드립니다."}}

    def proposal(self, body, config):
        kind = body.get("kind")
        action_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        status = "awaiting_approval"
        if kind == "mail_reply":
            text = config.get("replyBody", "해당 시간 가능합니다.")
            display = {"sender": "가상 담당자 <sender@example.invalid>", "subject": "회의 시간 확인", "body": text}
            if config.get("rejectProposal") or len(text) > 120:
                status = "rejected"
                sentences = [self.spoken("한 문장으로 짧게 다시 말씀해 주세요.")]
            elif config.get("needsClarification"):
                status = "needs_clarification"
                sentences = [self.spoken("오전인지 오후인지 한 번만 확인해 주세요.")]
            else:
                status = "awaiting_approval"
                sentences = [self.spoken("가상 담당자 님에게 '" + text + "'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.")]
        else:
            display = {"title": "회의 시간 확인", "start": "2026-11-10T14:00:00+09:00",
                       "end": "2026-11-10T14:30:00+09:00", "timeZone": "Asia/Seoul"}
            if config.get("needsClarification"):
                status = "needs_clarification"
                sentences = [self.spoken("오전인지 오후인지 한 번만 확인해 주세요.")]
            else:
                sentences = [self.spoken("2026년 11월 10일 오후 두 시부터 두 시 삼십 분까지 '회의 시간 확인' 일정을 내 캘린더에 추가할게요. 추가하려면 '추가해'라고 말씀해 주세요.")]
        value = {"actionId": action_id, "version": 1, "status": status,
                 "contentHash": hashlib.sha256((action_id + kind).encode()).hexdigest(), "sentences": sentences,
                 "display": display, "expiresAt": now + int(config.get("proposalTtlMs", 90000))}
        ACTIONS[action_id] = {"value": value, "status": value["status"], "executeAt": None,
                              "kind": kind, "cancelled": False, "clarified": False,
                              "missingPayload": bool(config.get("readbackMissingPayload")),
                              "scenario": config.get("actionScenario", "reply"), "expiresAt": value["expiresAt"]}
        return value

    @staticmethod
    def normalized_verb(value):
        value = unicodedata.normalize("NFKC", value).strip()
        return re.sub(r"^[\s\.,!?。！？…'\"“”‘’]+|[\s\.,!?。！？…'\"“”‘’]+$", "", value)

    @staticmethod
    def valid_action_audio(audio):
        if not isinstance(audio, dict) or audio.get("mimeType") != "audio/wav" or not isinstance(audio.get("data"), str):
            return False
        try:
            raw = base64.b64decode(audio["data"], validate=True)
            with wave.open(io.BytesIO(raw), "rb") as source:
                return (len(raw) <= 256044 and source.getframerate() == 16000 and source.getnchannels() == 1 and
                        source.getsampwidth() == 2 and 1 <= source.getnframes() <= 128000)
        except (ValueError, wave.Error):
            return False

    def action_route(self, path, body, config):
        if path == "/v1/capabilities":
            enabled = bool(config.get("actionScenario") or config.get("actionsEnabled"))
            return 200, {"calendarRead": True, "mailRead": enabled, "mailReply": enabled,
                         "calendarInsert": enabled, "reconnectRequired": False}
        if path == "/v1/mail/scan":
            body = body or {}
            if "quiet" in body and not isinstance(body["quiet"], bool):
                return 400, {"error": {"code": "INVALID_REQUEST", "message": "fixture"}}
            candidate = self.candidate(config)
            if body.get("quiet") is True and not candidate["sensitive"]:
                candidate.update(canReply=False, canAddCalendar=False,
                                 sentences=[self.spoken("확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.")],
                                 replyPromptSentences=[])
                candidate.pop("calendarOfferSentences", None)
            return 200, {"candidate": candidate}
        if path == "/v1/actions/proposals":
            body = body or {}
            try:
                request_id = str(uuid.UUID(body.get("requestId", "")))
            except (ValueError, AttributeError):
                return 400, {"error": {"code": "INVALID_REQUEST", "message": "fixture"}}
            kind = body.get("kind")
            audio = body.get("audio")
            if kind == "mail_reply":
                valid = bool(body.get("candidateId")) and self.valid_action_audio(audio)
            elif kind == "calendar_insert":
                valid = bool(body.get("candidateId")) or self.valid_action_audio(audio)
            else:
                valid = False
            if not valid:
                return 400, {"error": {"code": "INVALID_REQUEST", "message": "fixture"}}
            fingerprint = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True,
                                                    separators=(",", ":")).encode()).hexdigest()
            previous = REQUESTS_BY_ID.get(request_id)
            if previous is not None:
                if previous[0] != fingerprint:
                    return 409, {"error": {"code": "CONFLICT", "message": "fixture"}}
                return 200, ACTIONS[previous[1]]["value"]
            value = self.proposal(body, config)
            REQUESTS_BY_ID[request_id] = (fingerprint, value["actionId"])
            return 200, value
        match = re.fullmatch(r"/v1/actions/([^/]+)(?:/(approve|cancel|clarify|readback))?", path)
        if not match or match.group(1) not in ACTIONS:
            return 404, {"error": {"code": "NOT_FOUND", "message": "fixture"}}
        action_id, operation = match.groups()
        action = ACTIONS[action_id]
        if operation == "readback":
            failure_status = config.get("readbackStatus")
            if failure_status in (404, 410):
                return failure_status, {"error": {"code": "NOT_FOUND" if failure_status == 404 else "EXPIRED",
                                                    "message": "fixture"}}
            if self.command != "POST":
                return 405, {"error": {"code": "METHOD_NOT_ALLOWED", "message": "fixture"}}
            if not isinstance(body, dict) or body:
                return 400, {"error": {"code": "BAD_REQUEST", "message": "fixture"}}
            if action["missingPayload"] or action["expiresAt"] <= int(time.time() * 1000) or action["status"] == "expired":
                return 410, {"error": {"code": "EXPIRED", "message": "fixture"}}
            if action["status"] not in {"awaiting_approval", "needs_clarification", "rejected"}:
                return 409, {"error": {"code": "CONFLICT", "message": "fixture"}}
            return 200, action["value"]
        if operation == "approve":
            if action["status"] == "awaiting_approval" and int(time.time() * 1000) >= action["expiresAt"]:
                action["status"] = "expired"
            if action["status"] == "holding" and action.get("approvalResponse"):
                return 200, action["approvalResponse"]
            if action["status"] != "awaiting_approval":
                no_write = "보내지 않았어요." if action["kind"] == "mail_reply" else "일정을 추가하지 않았어요."
                return 200, {"actionId": action_id, "status": "not_approved", "reasonCode": "NOT_AWAITING_APPROVAL",
                             "sentences": [self.spoken(no_write)]}
            voice = config.get("approvalTranscript", "보내" if action["kind"] == "mail_reply" else "추가해")
            allowed = {"mail_reply": {"보내", "보내줘", "보내 줘"},
                       "calendar_insert": {"추가해", "추가해줘", "추가해 줘", "등록해", "등록해줘", "등록해 줘"}}
            if body.get("version") != action["value"]["version"] or body.get("contentHash") != action["value"].get("contentHash"):
                return 409, {"error": {"code": "CONFLICT", "message": "fixture"}}
            if body.get("channel") not in {"voice", "parked_button"}:
                return 400, {"error": {"code": "INVALID_REQUEST", "message": "fixture"}}
            if body.get("channel") == "voice" and (not self.valid_action_audio(body.get("audio")) or
                                                       self.normalized_verb(voice) not in allowed[action["kind"]]):
                no_write = "보내지 않았어요." if action["kind"] == "mail_reply" else "일정을 추가하지 않았어요."
                return 200, {"actionId": action_id, "status": "not_approved", "reasonCode": "EXACT_VERB_REQUIRED",
                             "sentences": [self.spoken(no_write)]}
            now = int(time.time() * 1000)
            action["status"] = "holding"
            action["approvedAt"] = now
            action["executeAt"] = now + HOLD_AUDIO_MS + 14500
            action["approvalResponse"] = {"actionId": action_id, "status": "holding", "executeAt": action["executeAt"],
                                           "serverNow": now, "holdAudioMs": HOLD_AUDIO_MS,
                                           "holdSentences": [self.spoken("취소하려면 '취소'라고 말씀하세요.", HOLD_AUDIO)]}
            return 200, action["approvalResponse"]
        if operation == "cancel":
            cancelled = action["status"] in {"awaiting_approval", "needs_clarification", "holding", "preparing"}
            if cancelled:
                action["status"] = "cancelled"
                action["cancelled"] = True
            return 200, {"actionId": action_id, "status": action["status"], "cancelled": cancelled}
        if operation == "clarify":
            if action["kind"] != "calendar_insert" or action["status"] != "needs_clarification" or action["clarified"]:
                return 409, {"error": {"code": "CONFLICT", "message": "fixture"}}
            if body.get("version") != action["value"]["version"] or not self.valid_action_audio(body.get("audio")):
                return 409, {"error": {"code": "CONFLICT", "message": "fixture"}}
            value = dict(action["value"])
            value["version"] = action["value"]["version"] + 1
            value["status"] = "awaiting_approval"
            value["sentences"] = [self.spoken("2026년 11월 10일 오후 두 시부터 두 시 삼십 분까지 '회의 시간 확인' 일정을 내 캘린더에 추가할게요. 추가하려면 '추가해'라고 말씀해 주세요.")]
            action["clarified"] = True
            action["status"] = value["status"]
            action["value"] = value
            return 200, value
        if action["status"] == "awaiting_approval" and int(time.time() * 1000) >= action["expiresAt"]:
            action["status"] = "expired"
        if action["status"] == "holding" and action["executeAt"] <= int(time.time() * 1000):
            action["status"] = "succeeded"
        sentences = None
        if action["status"] in {"succeeded", "cancelled", "unknown", "failed", "rejected", "expired"}:
            no_write = "보내지 않았어요." if action["kind"] == "mail_reply" else "일정을 추가하지 않았어요."
            failed = "보내지 못했어요." if action["kind"] == "mail_reply" else "일정을 추가하지 못했어요."
            unknown = ("처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요." if action["kind"] == "mail_reply"
                       else "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.")
            words = {"succeeded": "회신을 보냈어요." if action["kind"] == "mail_reply" else "캘린더에 추가했어요.",
                     "cancelled": no_write, "unknown": unknown,
                     "failed": failed, "rejected": no_write,
                     "expired": no_write}
            sentences = [self.spoken(words[action["status"]])]
        result = {"actionId": action_id, "kind": action["kind"], "status": action["status"]}
        if action["executeAt"] is not None:
            result["executeAt"] = action["executeAt"]
        if sentences is not None:
            result["sentences"] = sentences
        return 200, result

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        global POLLS, CONFIG, ACTIONS
        count = int(self.headers.get("Content-Length", 0))
        if count > 512 * 1024:
            return self.answer(413, {"error": {"code": "PAYLOAD_TOO_LARGE", "message": "fixture"}, "fallback": "cached_knock_or_silence"})
        body = json.loads(self.rfile.read(count)) if count else None
        if self.path == "/__test/config" and self.command == "POST":
            with LOCK:
                CONFIG = body or {}; POLLS = 0
            return self.answer(200, {"ok": True})
        if self.path == "/__test/state":
            with LOCK:
                private = {"transcript", "approvalTranscript", "replyBody"}
                actions = [{"actionId": action_id, "kind": action["kind"], "status": action["status"],
                            "approvedAt": action.get("approvedAt"), "executeAt": action["executeAt"]}
                           for action_id, action in ACTIONS.items()]
                return self.answer(200, {"requests": list(COUNTS), "actions": actions,
                                         "config": {k: v for k, v in CONFIG.items() if k not in private}})
        if self.path == "/__test/reset":
            with LOCK:
                CONFIG = {}; COUNTS.clear(); POLLS = 0; ACTIONS.clear(); REQUESTS_BY_ID.clear()
            return self.answer(200, {"ok": True})
        with LOCK:
            conf = dict(CONFIG)
            COUNTS.append({"method": self.command, "path": self.path, "size": count,
                           "authMatches": self.headers.get("Authorization") == "Bearer " + TOKEN,
                           "at": time.monotonic()})
        if self.path != "/v1/devices" and self.headers.get("Authorization") != "Bearer " + TOKEN and not conf.get("status"):
            return self.answer(401, {"error": {"code": "UNAUTHORIZED", "message": "fixture"}, "fallback": "cached_knock_or_silence"})
        if conf.get("delay") and self.path == conf.get("delayPath", "/v1/turns"):
            time.sleep(conf["delay"])
        status = conf.get("status")
        if status and self.path == conf.get("statusPath", "/v1/today"):
            error = {"error": {"code": "INTERNAL_ERROR" if status == 502 else "UNAUTHORIZED" if status == 401 else "PAIRING_REQUIRED" if status == 403 else "DEVICE_DAILY_LIMIT", "message": "NEVER_SPEAK_FIXTURE"}, "fallback": "cached_knock_or_silence"}
            if status == 429:
                error["retryAfterSeconds"] = 60
            return self.answer(status, error)
        path = self.path
        if path.startswith("/v1/actions") or path in {"/v1/capabilities", "/v1/mail/scan"}:
            status_code, value = self.action_route(path, body, conf)
            return self.answer(status_code, value, conf)
        if path == "/v1/devices":
            return self.answer(201, {"deviceId": DEVICE_ID, "deviceToken": TOKEN})
        if path == "/v1/pairing":
            return self.answer(200, {"code": CODE, "pairingUrl": f"http://127.0.0.1:8788/pair/{CODE}", "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")})
        if path == "/v1/pairing/" + CODE:
            POLLS += 1
            return self.answer(200, {"status": "paired" if POLLS >= conf.get("pairingPolls", 2) else "pending", "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")})
        if path == "/v1/today":
            return self.answer(200, today(conf.get("productionKnock", False)), conf)
        if path == "/v1/briefings":
            assert set(body) == {"tripId", "remainingSeconds"}
            seconds = body["remainingSeconds"]
            bucket = "summary" if seconds is None else "short" if seconds < 300 else "summary" if seconds < 900 else "full"
            text = "오늘 일정은 세 개예요." + (" 열 시에 가상 일정이 있어요." if bucket != "short" else "") + (" 열한 시에 가상 일정이 있어요. 열두 시에 가상 일정이 있어요." if bucket == "full" else "")
            spoken = AUDIO if not conf.get("briefingSeconds") else {"data": base64.b64encode(wav_bytes(conf["briefingSeconds"])).decode(), "mimeType": "audio/wav"}
            return self.answer(200, {"briefingId": str(uuid.uuid4()), "tripId": body["tripId"], "bucket": bucket, "text": text, "audio": spoken}, conf)
        if path in ("/v1/confirm", "/v1/turns"):
            audio = body["audio"]
            raw = base64.b64decode(audio["data"], validate=True)
            assert audio["mimeType"] == "audio/wav" and len(raw) <= 256044
            with wave.open(io.BytesIO(raw)) as w:
                assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2 and 1 <= w.getnframes() <= 128000
            text = conf.get("transcript", "응" if path.endswith("confirm") else "오늘 일정 알려줘.")
            if path.endswith("confirm"):
                return self.answer(200, {"transcript": text, "match": {"label": "보내" if conf.get("advisorySend") else text or "NONE", "action": "SEND" if conf.get("advisorySend") else "LISTEN" if text else "NOT_NOW", "mode": "exact" if text else "none"}}, conf)
            response = {"turnId": str(uuid.uuid4()), "transcript": text, "sentences": [{"text": "오늘 일정은 세 개예요.", "audio": AUDIO}] if text else []}
            if any(trigger in text for trigger in ("추가", "등록", "잡아")) and any(word in text for word in ("일정", "회의", "약속")):
                value = self.proposal({"kind": "calendar_insert"}, conf)
                response["sentences"] = [self.spoken("일정 내용을 확인할게요.")]
                response["actionProposalPending"] = {"actionId": value["actionId"], "version": value["version"]}
            return self.answer(200, response, conf)
        return self.answer(404, {"error": {"code": "NOT_FOUND", "message": "fixture"}, "fallback": "cached_knock_or_silence"})


def serve():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8788)
    options = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", options.port), Handler)
    server.daemon_threads = True
    print("fixture ready", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    serve()
