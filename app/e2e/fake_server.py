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
import struct
import threading
import time
import uuid
import wave

DEVICE_ID = "11111111-1111-4111-8111-111111111111"
TOKEN = DEVICE_ID + "." + "a" * 64
CODE = "P" * 43
LOCK = threading.Lock()
CONFIG = {}
COUNTS = []
POLLS = 0


def wav_bytes(seconds=.8, rate=44100):
    data = io.BytesIO()
    with wave.open(data, "wb") as w:
        w.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        w.writeframes(b"".join(struct.pack("<h", int(math.sin(2 * math.pi * 440 * i / rate) * 1500) if i < rate * .2 else 0) for i in range(int(rate * seconds))))
    return data.getvalue()


WAV = wav_bytes()
AUDIO = {"data": base64.b64encode(WAV).decode(), "mimeType": "audio/wav"}


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

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        global POLLS, CONFIG
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
                return self.answer(200, {"requests": list(COUNTS), "config": {k: v for k, v in CONFIG.items() if k != "transcript"}})
        if self.path == "/__test/reset":
            with LOCK:
                CONFIG = {}; COUNTS.clear(); POLLS = 0
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
            return self.answer(200, {"turnId": str(uuid.uuid4()), "transcript": text, "sentences": [{"text": "오늘 일정은 세 개예요.", "audio": AUDIO}] if text else []}, conf)
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
