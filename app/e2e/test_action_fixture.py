"""Host-only contract tests for the local action API fixture."""
import base64
import io
import wave
import importlib.util
from pathlib import Path
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import json

SPEC = importlib.util.spec_from_file_location("mobi_fake_server", Path(__file__).with_name("fake_server.py"))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class ActionFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = fixture.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.request("/__test/reset", {})
        self.request("/__test/config", {"actionScenario": "reply"})

    def request(self, path, body=None, method=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = Request(self.base + path, data=data, method=method or ("POST" if data is not None else "GET"),
                      headers={"Authorization": "Bearer " + fixture.TOKEN, "Content-Type": "application/json"})
        with urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read())

    def test_existing_non_action_scenarios_do_not_offer_mail(self):
        self.request("/__test/config", {})
        _, caps = self.request("/v1/capabilities")
        self.assertFalse(caps["mailRead"])
        self.assertFalse(caps["mailReply"])

    def test_capabilities_and_mail_scan_contract(self):
        _, caps = self.request("/v1/capabilities")
        self.assertEqual({"calendarRead", "mailRead", "mailReply", "calendarInsert", "reconnectRequired"}, set(caps))
        self.assertTrue(all(caps[name] for name in ("calendarRead", "mailRead", "mailReply", "calendarInsert")))
        _, scanned = self.request("/v1/mail/scan", {"tripId": 7})
        candidate = scanned["candidate"]
        self.assertEqual({"candidateId", "sensitive", "canReply", "canAddCalendar", "sentences",
                          "replyPromptSentences", "calendarOfferSentences", "display"}, set(candidate))
        self.assertTrue(candidate["sentences"][0]["text"].endswith("회신 내용을 작성할까요?"))
        self.assertTrue(candidate["calendarOfferSentences"][0]["text"].endswith("일정 내용을 확인할까요?"))
        self.assertFalse(candidate["sensitive"])
        self.assertIn("가상 담당자", candidate["sentences"][0]["text"])

    def test_reply_proposal_approve_hold_cancel_and_status(self):
        _, proposal = self.request("/v1/actions/proposals", {
            "tripId": 7, "requestId": "11111111-1111-4111-8111-111111111112",
            "kind": "mail_reply", "candidateId": "fixture-mail-1", "audio": fixture.ACTION_AUDIO,
        })
        self.assertEqual("awaiting_approval", proposal["status"])
        _, approval = self.request("/v1/actions/%s/approve" % proposal["actionId"], {
            "contentHash": proposal["contentHash"], "version": proposal["version"],
            "channel": "voice", "audio": fixture.ACTION_AUDIO,
        })
        self.assertEqual("holding", approval["status"])
        self.assertEqual(17500, approval["executeAt"] - approval["serverNow"])
        self.assertEqual(3000, approval["holdAudioMs"])
        self.assertEqual("취소하려면 '취소'라고 말씀하세요.", approval["holdSentences"][0]["text"])
        with wave.open(io.BytesIO(base64.b64decode(approval["holdSentences"][0]["audio"]["data"])), "rb") as clip:
            self.assertEqual(3.0, clip.getnframes() / clip.getframerate())
        _, status = self.request("/v1/actions/%s" % proposal["actionId"])
        self.assertEqual("holding", status["status"])
        _, cancelled = self.request("/v1/actions/%s/cancel" % proposal["actionId"], {})
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual("cancelled", cancelled["status"])
        _, terminal = self.request("/v1/actions/%s" % proposal["actionId"])
        self.assertEqual("cancelled", terminal["status"])
        self.assertEqual("보내지 않았어요.", terminal["sentences"][0]["text"])

    def test_quiet_scan_announces_arrival_only_and_keeps_details_for_parked_display(self):
        _, normal = self.request("/v1/mail/scan", {"tripId": 7})
        _, quiet = self.request("/v1/mail/scan", {"tripId": 7, "quiet": True})
        candidate = quiet["candidate"]
        self.assertFalse(candidate["canReply"])
        self.assertFalse(candidate["canAddCalendar"])
        self.assertEqual(normal["candidate"]["display"], candidate["display"])
        self.assertEqual([], candidate["replyPromptSentences"])
        self.assertNotIn("calendarOfferSentences", candidate)
        self.assertEqual(["확인이 필요한 메일이 있어요. 정차 후 확인해 주세요."],
                         [sentence["text"] for sentence in candidate["sentences"]])
        spoken = json.dumps(candidate["sentences"], ensure_ascii=False)
        for private in candidate["display"].values():
            self.assertNotIn(private, spoken)
        self.assertEqual([], self.request("/__test/state")[1]["actions"])

    def test_quiet_off_keeps_existing_scan_response_identical(self):
        _, original = self.request("/v1/mail/scan", {"tripId": 7})
        _, explicit_off = self.request("/v1/mail/scan", {"tripId": 7, "quiet": False})
        self.assertEqual(json.dumps(original, ensure_ascii=False), json.dumps(explicit_off, ensure_ascii=False))

    def test_sensitive_scan_is_unchanged_when_quiet_is_on(self):
        self.request("/__test/config", {"sensitiveMail": True})
        _, original = self.request("/v1/mail/scan", {"tripId": 7})
        _, quiet = self.request("/v1/mail/scan", {"tripId": 7, "quiet": True})
        self.assertEqual(original, quiet)

    def test_quiet_flag_requires_a_boolean_when_present(self):
        for value in ("true", 1, None, {}):
            with self.subTest(quiet=value):
                with self.assertRaises(HTTPError) as failure:
                    self.request("/v1/mail/scan", {"tripId": 7, "quiet": value})
                self.assertEqual(400, failure.exception.code)
                failure.exception.close()

    def test_terminal_action_sentences_match_kind_and_execution_stage(self):
        for index, kind in enumerate(("mail_reply", "calendar_insert"), start=1):
            no_write = "보내지 않았어요." if kind == "mail_reply" else "일정을 추가하지 않았어요."
            failed = "보내지 못했어요." if kind == "mail_reply" else "일정을 추가하지 못했어요."
            unknown = ("처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요." if kind == "mail_reply"
                       else "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.")
            expected = {"cancelled": no_write, "expired": no_write, "rejected": no_write,
                        "failed": failed, "unknown": unknown}
            for offset, (status, sentence) in enumerate(expected.items()):
                request_id = "11111111-1111-4111-8111-%012d" % (500 + index * 10 + offset)
                _, proposal = self.request("/v1/actions/proposals", {
                    "tripId": 500 + index * 10 + offset, "requestId": request_id,
                    "kind": kind, "candidateId": "fixture-mail-1", "audio": fixture.ACTION_AUDIO,
                })
                fixture.ACTIONS[proposal["actionId"]]["status"] = status
                _, terminal = self.request("/v1/actions/%s" % proposal["actionId"])
                with self.subTest(kind=kind, status=status):
                    self.assertEqual(status, terminal["status"])
                    self.assertEqual(sentence, terminal["sentences"][0]["text"])
                    if status == "unknown":
                        self.assertIn("다시", sentence)
                        if kind == "calendar_insert":
                            self.assertNotIn("다시 보내", sentence)
        state = self.request("/__test/state")[1]
        self.assertFalse(any(row["path"].endswith("/approve") for row in state["requests"]))

    def test_proposal_request_id_is_idempotent_and_rejects_changed_input(self):
        body = {"tripId": 13, "requestId": "11111111-1111-4111-8111-111111111116",
                "kind": "mail_reply", "candidateId": "fixture-mail-1", "audio": fixture.ACTION_AUDIO}
        _, first = self.request("/v1/actions/proposals", body)
        _, retry = self.request("/v1/actions/proposals", body)
        self.assertEqual(first["actionId"], retry["actionId"])
        changed = dict(body, candidateId="fixture-mail-other")
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/proposals", changed)
        self.assertEqual(409, failure.exception.code)
        failure.exception.close()

    def test_approval_rejects_wrong_version_or_hash_and_replay_keeps_original_hold(self):
        _, proposal = self.request("/v1/actions/proposals", {
            "tripId": 14, "requestId": "11111111-1111-4111-8111-111111111117",
            "kind": "mail_reply", "candidateId": "fixture-mail-1", "audio": fixture.ACTION_AUDIO,
        })
        path = "/v1/actions/%s/approve" % proposal["actionId"]
        approval = {"contentHash": proposal["contentHash"], "version": proposal["version"],
                    "channel": "parked_button"}
        with self.assertRaises(HTTPError) as failure:
            self.request(path, dict(approval, contentHash="wrong-hash"))
        self.assertEqual(409, failure.exception.code)
        failure.exception.close()
        with self.assertRaises(HTTPError) as failure:
            self.request(path, dict(approval, version=proposal["version"] + 1))
        self.assertEqual(409, failure.exception.code)
        failure.exception.close()
        _, first = self.request(path, approval)
        _, replay = self.request(path, approval)
        self.assertEqual("holding", first["status"])
        self.assertEqual(first["executeAt"], replay["executeAt"])
        self.assertEqual(first["serverNow"], replay["serverNow"])

    def test_approval_uses_exact_action_verb_and_never_logs_payload(self):
        self.request("/__test/config", {"actionScenario": "reply", "approvalTranscript": "응"})
        _, proposal = self.request("/v1/actions/proposals", {
            "tripId": 7, "requestId": "11111111-1111-4111-8111-111111111113",
            "kind": "mail_reply", "candidateId": "fixture-mail-1", "audio": fixture.ACTION_AUDIO,
        })
        _, declined = self.request("/v1/actions/%s/approve" % proposal["actionId"], {
            "contentHash": proposal["contentHash"], "version": proposal["version"], "channel": "voice", "audio": fixture.ACTION_AUDIO,
        })
        self.assertEqual("not_approved", declined["status"])
        self.assertEqual("EXACT_VERB_REQUIRED", declined["reasonCode"])
        _, state = self.request("/__test/state")
        serialized = json.dumps(state, ensure_ascii=False)
        for marker in ("해당 시간 가능합니다", "응", fixture.AUDIO["data"]):
            self.assertNotIn(marker, serialized)
        action_requests = [r for r in state["requests"] if "/actions" in r["path"]]
        self.assertTrue(action_requests)
        self.assertTrue(all("body" not in r and "transcript" not in r for r in action_requests))

    def test_reply_approval_accepts_only_exact_verb_after_normalization(self):
        for index, (transcript, expected) in enumerate((("응", "not_approved"), ("네", "not_approved"),
                                                         ("보내지 마", "not_approved"), ("보내요", "not_approved"),
                                                         ("보내.", "holding")), start=20):
            with self.subTest(transcript=transcript):
                self.request("/__test/config", {"approvalTranscript": transcript})
                _, proposal = self.request("/v1/actions/proposals", {
                    "tripId": index, "requestId": "11111111-1111-4111-8111-%012d" % index,
                    "kind": "mail_reply", "candidateId": "fixture-mail-1", "audio": fixture.ACTION_AUDIO,
                })
                _, result = self.request("/v1/actions/%s/approve" % proposal["actionId"], {
                    "contentHash": proposal["contentHash"], "version": proposal["version"],
                    "channel": "voice", "audio": fixture.ACTION_AUDIO,
                })
                self.assertEqual(expected, result["status"])
                state = self.request("/__test/state")[1]
                action = next(row for row in state["actions"] if row["actionId"] == proposal["actionId"])
                self.assertEqual(expected == "holding", action["approvedAt"] is not None)

    def test_sensitive_mail_scan_suppresses_subject_and_calendar_fields(self):
        self.request("/__test/config", {"sensitiveMail": True})
        _, result = self.request("/v1/mail/scan", {"tripId": 11})
        candidate = result["candidate"]
        self.assertTrue(candidate["sensitive"])
        self.assertFalse(candidate["canReply"])
        self.assertFalse(candidate["canAddCalendar"])
        self.assertEqual({"sender"}, set(candidate["display"]))
        self.assertEqual("민감한 내용으로 보여 정차 후 확인해 주세요.", candidate["sentences"][0]["text"])

    def test_calendar_clarification_is_single_use(self):
        self.request("/__test/config", {"needsClarification": True})
        _, proposal = self.request("/v1/actions/proposals", {
            "tripId": 12, "requestId": "11111111-1111-4111-8111-111111111115",
            "kind": "calendar_insert", "audio": fixture.ACTION_AUDIO,
        })
        self.assertEqual("needs_clarification", proposal["status"])
        _, clarified = self.request("/v1/actions/%s/clarify" % proposal["actionId"], {
            "version": proposal["version"], "audio": fixture.ACTION_AUDIO,
        })
        self.assertEqual("awaiting_approval", clarified["status"])
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/%s/clarify" % proposal["actionId"], {
                "version": clarified["version"], "audio": fixture.ACTION_AUDIO,
            })
        self.assertEqual(409, failure.exception.code)
        failure.exception.close()

    def test_cancel_holding_calendar_action_is_recorded_by_fixture(self):
        self.request("/__test/config", {"actionScenario": "cancel_hold", "approvalTranscript": "추가해"})
        _, proposal = self.request("/v1/actions/proposals", {
            "tripId": 9, "requestId": "11111111-1111-4111-8111-111111111114",
            "kind": "calendar_insert", "audio": fixture.ACTION_AUDIO,
        })
        _, approval = self.request("/v1/actions/%s/approve" % proposal["actionId"], {
            "contentHash": proposal["contentHash"], "version": proposal["version"], "channel": "voice", "audio": fixture.ACTION_AUDIO,
        })
        self.assertEqual("holding", approval["status"])
        _, cancelled = self.request("/v1/actions/%s/cancel" % proposal["actionId"], {})
        self.assertEqual("cancelled", cancelled["status"])
        _, state = self.request("/__test/state")
        paths = [r["path"] for r in state["requests"]]
        self.assertEqual(1, paths.count("/v1/actions/%s/cancel" % proposal["actionId"]))
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual("cancelled", state["actions"][0]["status"])

    def test_calendar_voice_turn_returns_pending_without_full_proposal(self):
        self.request("/__test/config", {"transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘"})
        _, result = self.request("/v1/turns", {"audio": fixture.ACTION_AUDIO})
        self.assertEqual("일정 내용을 확인할게요.", result["sentences"][0]["text"])
        self.assertNotIn("actionProposal", result)
        pending = result["actionProposalPending"]
        self.assertEqual({"actionId", "version"}, set(pending))
        action_id = pending["actionId"]
        before = self.request("/__test/state")[1]
        action_before = next(action for action in before["actions"] if action["actionId"] == action_id)
        readback_path = "/v1/actions/%s/readback" % action_id
        _, readback = self.request(readback_path, {})
        _, replay = self.request(readback_path, {})
        self.assertEqual(readback, replay)
        self.assertEqual("awaiting_approval", readback["status"])
        self.assertIn("title", readback["display"])
        self.assertTrue(readback["sentences"])
        after = self.request("/__test/state")[1]
        action_after = next(action for action in after["actions"] if action["actionId"] == action_id)
        self.assertEqual(action_before, action_after)
        self.assertEqual(1, sum(row["path"] == "/v1/turns" for row in after["requests"]))
        self.assertEqual(2, sum(row["path"] == readback_path for row in after["requests"]))
        self.assertFalse(any(row["path"].endswith("/approve") for row in after["requests"]))

    def test_calendar_readback_failure_has_no_approval_side_effect(self):
        self.request("/__test/config", {"transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘",
                                         "readbackStatus": 410})
        _, turn = self.request("/v1/turns", {"audio": fixture.ACTION_AUDIO})
        pending = turn["actionProposalPending"]
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/%s/readback" % pending["actionId"], {})
        self.assertEqual(410, failure.exception.code)
        failure.exception.close()
        state = self.request("/__test/state")[1]
        action = next(row for row in state["actions"] if row["actionId"] == pending["actionId"])
        self.assertEqual("awaiting_approval", action["status"])
        self.assertIsNone(action["approvedAt"])
        self.assertFalse(any(row["path"].endswith("/approve") for row in state["requests"]))

    def test_readback_requires_post_and_empty_body(self):
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/11111111-1111-4111-8111-111111111999/readback", {})
        self.assertEqual(404, failure.exception.code)
        failure.exception.close()
        self.request("/__test/config", {"transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘"})
        _, turn = self.request("/v1/turns", {"audio": fixture.ACTION_AUDIO})
        action_id = turn["actionProposalPending"]["actionId"]
        path = "/v1/actions/%s/readback" % action_id
        with self.assertRaises(HTTPError) as failure:
            self.request(path, method="GET")
        self.assertEqual(405, failure.exception.code)
        failure.exception.close()
        with self.assertRaises(HTTPError) as failure:
            self.request(path, {"unexpected": True})
        self.assertEqual(400, failure.exception.code)
        failure.exception.close()
        state = self.request("/__test/state")[1]
        action = next(row for row in state["actions"] if row["actionId"] == action_id)
        self.assertEqual("awaiting_approval", action["status"])
        self.assertIsNone(action["approvedAt"])

    def test_readback_rejects_holding_action_without_mutating_it(self):
        _, proposal = self.request("/v1/actions/proposals", {
            "tripId": 26, "requestId": "11111111-1111-4111-8111-111111111126",
            "kind": "calendar_insert", "audio": fixture.ACTION_AUDIO,
        })
        self.request("/v1/actions/%s/approve" % proposal["actionId"], {
            "version": proposal["version"], "contentHash": proposal["contentHash"],
            "channel": "parked_button",
        })
        before = self.request("/__test/state")[1]
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/%s/readback" % proposal["actionId"], {})
        self.assertEqual(409, failure.exception.code)
        failure.exception.close()
        after = self.request("/__test/state")[1]
        action_before = next(row for row in before["actions"] if row["actionId"] == proposal["actionId"])
        action_after = next(row for row in after["actions"] if row["actionId"] == proposal["actionId"])
        self.assertEqual(action_before, action_after)
        self.assertEqual("holding", action_after["status"])

    def test_readback_clock_expiry_and_missing_payload_return_gone_without_mutation(self):
        self.request("/__test/config", {"transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘",
                                         "proposalTtlMs": -1})
        _, expired_turn = self.request("/v1/turns", {"audio": fixture.ACTION_AUDIO})
        expired_id = expired_turn["actionProposalPending"]["actionId"]
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/%s/readback" % expired_id, {})
        self.assertEqual(410, failure.exception.code)
        failure.exception.close()
        state = self.request("/__test/state")[1]
        expired_action = next(row for row in state["actions"] if row["actionId"] == expired_id)
        self.assertEqual("awaiting_approval", expired_action["status"])

        self.request("/__test/reset", {})
        self.request("/__test/config", {"transcript": "내일 오후 두 시 팀 회의 일정 추가해 줘",
                                         "readbackMissingPayload": True})
        _, missing_turn = self.request("/v1/turns", {"audio": fixture.ACTION_AUDIO})
        missing_id = missing_turn["actionProposalPending"]["actionId"]
        with self.assertRaises(HTTPError) as failure:
            self.request("/v1/actions/%s/readback" % missing_id, {})
        self.assertEqual(410, failure.exception.code)
        failure.exception.close()
        state = self.request("/__test/state")[1]
        missing_action = next(row for row in state["actions"] if row["actionId"] == missing_id)
        self.assertEqual("awaiting_approval", missing_action["status"])


if __name__ == "__main__":
    unittest.main()
