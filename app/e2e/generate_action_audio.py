#!/usr/bin/env python3
"""One-shot, bounded generation of the fixed action speech resources. Never logs credentials."""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
import wave
import tomllib
import zipfile

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
RAW = APP / "app/src/main/res/raw"
MANIFEST = ROOT / ".context/actions/audio-workers-generation.json"
WORDING_MANIFEST = APP / "e2e/action-wording-audio.json"
QUOTA = Path(__import__("os").environ.get("MOBI_TTS_QUOTA_CHECK", ROOT / ".context/tts/quota-check.json"))
MODEL = "@cf/myshell-ai/melotts"
LANGUAGE = "kr"
MAX_REQUESTS = 15


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def save(value):
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def texts():
    constants = dict(re.findall(r'const val (\w+) = "([^"\n]*)"',
                               (APP / "app/src/main/java/dev/mobi/ui/DemoActions.kt").read_text()))
    values = {
        "unknown": "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요.",
    }
    names = {
        "demo_mail": "offerSentences", "demo_prompt": "replyPrompt", "demo_reply": "replyReadback",
        "demo_calendar": "calendarReadback", "demo_calendar_offer": "calendarOffer",
        "demo_hold_reply": "holdReply", "demo_hold_calendar": "holdCalendar",
        "demo_reply_result": "replyResult", "demo_calendar_result": "calendarResult",
    }
    values.update({name: constants[key] for name, key in names.items()})
    return {f"action_{name}.wav": text for name, text in values.items()}


def probe(path):
    completed = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                                "stream=codec_name,sample_rate,channels,bits_per_sample,duration:format=duration,size",
                                "-of", "json", str(path)], capture_output=True, check=True)
    value = json.loads(completed.stdout)
    stream = value["streams"][0]
    assert stream["codec_name"] == "pcm_s16le"
    assert int(stream["sample_rate"]) == 44100 and stream["channels"] == 1
    assert stream["bits_per_sample"] == 16
    return {"codec": stream["codec_name"], "sampleRate": 44100, "channels": 1, "bitsPerSample": 16,
            "durationSeconds": float(value["format"]["duration"]), "bytes": int(value["format"]["size"])}


def main():
    if WORDING_MANIFEST.exists():
        print(json.dumps({"status": "BLOCKED", "reason": "USE_GENERATE_ACTION_WORDING_AUDIO_MJS"}), flush=True)
        return 1
    requested = texts()
    assert len(requested) == 10
    previous = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    if previous.get("requests", 0) and "--authorized-retry" not in sys.argv:
        print(json.dumps({"status": "BLOCKED", "reason": "EXISTING_REQUEST_LEDGER"}), flush=True)
        return 1
    assert not previous.get("clips"), "A partial or complete generation must be reviewed before replacement"
    quota = json.loads(QUOTA.read_text())
    assert quota["remaining_of_10000_estimate"] >= 1000
    # Existing wrangler OAuth stays in memory and is used only in the Authorization header.
    config = tomllib.loads((Path.home() / "Library/Preferences/.wrangler/config/default.toml").read_text())
    token = config["oauth_token"]
    assert token and "\n" not in token and "\r" not in token
    expiry = config.get("expiration_time")
    when = expiry if isinstance(expiry, datetime) else datetime.fromisoformat(str(expiry).replace("Z", "+00:00"))
    assert when > datetime.now(timezone.utc), "Existing login must be current; never rotate credentials here"
    assert "ai:write" in config.get("scopes", [])
    prior = list(previous.get("previousAttempts", []))
    if previous.get("requests", 0):
        prior.append({key: previous[key] for key in ("requests", "inferenceRequests", "status", "httpStatus", "authError") if key in previous})
    state = {"model": MODEL, "language": LANGUAGE, "sampleRate": 44100, "maxRequests": MAX_REQUESTS,
             "requests": 0, "inferenceRequests": 0, "status": "generating", "clips": {},
             "previousAttempts": prior, "maxInferenceRequests": 10, "tokensWritten": False,
             "quotaBaselineCheckedUtc": quota.get("checked_utc"),
             "quotaBaselineRemainingEstimate": quota["remaining_of_10000_estimate"],
             "replacedAudioHashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in RAW.glob("action_*.wav")}}
    opener = urllib.request.build_opener(NoRedirect())
    def request(url, payload=None):
        assert state["requests"] < MAX_REQUESTS
        state["requests"] += 1
        save(state)
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "wrangler"}
        req = urllib.request.Request(url, data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode(), headers=headers)
        with opener.open(req, timeout=90) as response:
            data = response.read(16 * 1024 * 1024 + 1)
            content_type = response.headers.get("Content-Type", "")
        assert len(data) <= 16 * 1024 * 1024
        return data, content_type
    try:
        memory_credentials = [value for name, value in config.items() if name.endswith("token") and isinstance(value, str)]
        raw, _ = request("https://api.cloudflare.com/client/v4/accounts")
        accounts = json.loads(raw)["result"]
        assert len(accounts) == 1
        account = accounts[0]["id"]
        assert re.fullmatch(r"[a-f0-9]{32}", account)
        retired = 0
        deprecated = set(state["replacedAudioHashes"].values())
        old_manifest = ROOT / ".context/actions/audio-generation.json"
        if old_manifest.exists():
            deprecated.update(json.loads(old_manifest.read_text()).get("originalAudioHashes", {}).values())
        for archive in (APP / "app/build/outputs").rglob("*"):
            if archive.suffix not in {".apk", ".aab"} or not archive.is_file():
                continue
            with zipfile.ZipFile(archive) as package:
                contains_old = any(hashlib.sha256(package.read(info)).hexdigest() in deprecated
                                   for info in package.infolist() if info.filename.endswith(".wav"))
            if contains_old:
                archive.unlink()
                retired += 1
        state["retiredShippingArchives"] = retired
        for path in RAW.glob("action_*.wav"):
            path.unlink()
        save(state)
        for name, text in requested.items():
            assert state["inferenceRequests"] < 10
            state["inferenceRequests"] += 1
            raw, content_type = request("https://api.cloudflare.com/client/v4/accounts/" + account + "/ai/run/" + MODEL,
                                        {"prompt": text, "lang": LANGUAGE})
            audio = raw
            wrapped = "json" in content_type or raw.lstrip().startswith(b"{")
            if wrapped:
                payload = json.loads(raw)
                result = payload.get("result", payload)
                value = result.get("audio") if isinstance(result, dict) else result
                assert isinstance(value, str)
                if value.startswith("data:"):
                    value = value.split(",", 1)[1]
                audio = base64.b64decode(value, validate=True)
            assert audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"
            assert len(audio) <= 2_097_152 and token.encode() not in audio
            with wave.open(io.BytesIO(audio), "rb") as wav:
                assert wav.getframerate() == 44100 and wav.getnchannels() == 1 and wav.getsampwidth() == 2
            # Preserve the delivered WAV byte for byte: no resampling, re-encoding, or replacement header.
            destination = RAW / name
            destination.write_bytes(audio)
            metadata = probe(destination)
            state["clips"][name] = dict(metadata, text=text, model=MODEL, language=LANGUAGE,
                textSha256=hashlib.sha256(text.encode()).hexdigest(), sha256=hashlib.sha256(audio).hexdigest(),
                responseAudioSha256=hashlib.sha256(audio).hexdigest(), bytePreserved=True, jsonBase64Wrapper=wrapped)
            save(state)
            print(json.dumps({"clip": name, "status": "OK", "inference": state["inferenceRequests"], **metadata}), flush=True)
        assert len(state["clips"]) == 10
        # Check transient credentials before this Python process drops them. Counts only are retained.
        leaks = 0
        for root in (APP, ROOT / ".context/actions"):
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                data = path.read_bytes()
                leaks += sum(data.count(value.encode()) for value in memory_credentials if value)
        state["transientCredentialLeakMatches"] = leaks
        assert leaks == 0
        state["status"] = "complete"
        save(state)
        print(json.dumps({"status": "complete", "clips": 10, "requests": state["requests"],
                          "inferenceRequests": state["inferenceRequests"], "model": MODEL, "language": LANGUAGE}), flush=True)
        return 0
    except urllib.error.HTTPError as failure:
        state.update(status="blocked", httpStatus=failure.code)
        try:
            error_payload = json.loads(failure.read(65536))
            known_errors = {"invalid_grant", "invalid_client", "invalid_request", "unauthorized_client", "access_denied", "invalid_token"}
            if error_payload.get("error") in known_errors:
                state["authError"] = error_payload["error"]
            state["errorCodes"] = [v["code"] for v in error_payload.get("errors", [])
                                   if isinstance(v, dict) and isinstance(v.get("code"), int)]
        except Exception:
            state["errorResponseJson"] = False
        save(state)
        print(json.dumps({"status": "BLOCKED", "httpStatus": failure.code, "requests": state["requests"]}), flush=True)
        return 1
    except BaseException as failure:
        state.update(status="blocked", errorType=type(failure).__name__)
        save(state)
        print(json.dumps({"status": "BLOCKED", "errorType": type(failure).__name__, "requests": state["requests"]}), flush=True)
        return 1
    finally:
        token = None
        config = None


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as failure:
        print(json.dumps({"status": "BLOCKED", "errorType": type(failure).__name__}), flush=True)
        sys.exit(1)
