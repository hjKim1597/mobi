package dev.mobi.net

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class ActionApiContractTest {
    @Test fun quietMailScanFlagIsAddedOnlyWhenEnabled() {
        val ordinary = ActionApiContract.mailScanRequestJson("trip-1", quiet = false)
        assertEquals("{\"tripId\":\"trip-1\"}", ordinary.toString())
        val quiet = ActionApiContract.mailScanRequestJson("trip-1", quiet = true)
        assertEquals("trip-1", quiet.getString("tripId"))
        assertTrue(quiet.getBoolean("quiet"))
    }

    private val audio by lazy {
        val bytes = ByteArray(46)
        fun putAscii(offset: Int, value: String) = value.forEachIndexed { i, c -> bytes[offset + i] = c.code.toByte() }
        fun put16(offset: Int, value: Int) { bytes[offset] = value.toByte(); bytes[offset + 1] = (value shr 8).toByte() }
        fun put32(offset: Int, value: Int) { repeat(4) { bytes[offset + it] = (value shr (8 * it)).toByte() } }
        putAscii(0, "RIFF"); put32(4, 38); putAscii(8, "WAVE"); putAscii(12, "fmt "); put32(16, 16)
        put16(20, 1); put16(22, 1); put32(24, 8000); put32(28, 16000); put16(32, 2); put16(34, 16)
        putAscii(36, "data"); put32(40, 2); put16(44, 1)
        WavAudio(Base64.getEncoder().encodeToString(bytes))
    }
    private fun sentence(text: String) = JSONObject().put("text", text).put("audio", JSONObject().put("data", audio.data).put("mimeType", audio.mimeType))

    @Test fun decodesCapabilitiesAndSensitiveMailWithoutExposingOptionalDisplayText() {
        val capabilities = ActionApiContract.capabilities(JSONObject("""{"calendarRead":true,"mailRead":true,"mailReply":false,"calendarInsert":false,"reconnectRequired":true}"""))
        assertTrue(capabilities.mailRead); assertTrue(capabilities.reconnectRequired); assertFalse(capabilities.mailReply)

        val candidate = ActionApiContract.mailCandidate(JSONObject()
            .put("candidateId", "candidate-1").put("sensitive", true).put("canReply", false).put("canAddCalendar", false)
            .put("sentences", JSONArray().put(sentence("민감한 내용으로 보여 정차 후 확인해 주세요.")))
            .put("replyPromptSentences", JSONArray()).put("display", JSONObject().put("sender", "가상 담당자")))
        assertTrue(candidate.sensitive); assertNull(candidate.display.subject); assertNull(candidate.display.summary)
        assertEquals("가상 담당자", candidate.display.sender)
    }

    @Test fun decodesActionProposalAndTurnProposalAdditively() {
        val id = "00000000-0000-4000-8000-000000000001"
        val proposalJson = JSONObject().put("actionId", id).put("version", 1).put("status", "awaiting_approval")
            .put("contentHash", "a".repeat(64)).put("sentences", JSONArray().put(sentence("보내려면 보내라고 말씀해 주세요.")))
            .put("display", JSONObject().put("sender", "가상 담당자").put("subject", "회의 확인").put("body", "가능합니다.").put("to", "sender@example.invalid"))
            .put("expiresAt", "2026-11-08T12:00:00Z")
        val proposal = ActionApiContract.proposal(proposalJson)
        assertEquals(id, proposal.actionId); assertEquals("가능합니다.", proposal.display.body)
        val turn = ApiContract.turn(JSONObject().put("turnId", id).put("transcript", "내일 회의 추가해 줘")
            .put("sentences", JSONArray()).put("actionProposal", proposalJson))
        assertEquals(proposal, turn.actionProposal)
        val pending = ActionProposalPending(id, 3)
        val pendingTurn = ApiContract.turn(JSONObject().put("turnId", id).put("transcript", "내일 회의 추가해 줘")
            .put("sentences", JSONArray().put(sentence("일정 내용을 확인할게요.")))
            .put("actionProposalPending", JSONObject().put("actionId", id).put("version", 3)))
        assertEquals(pending, pendingTurn.actionProposalPending); assertNull(pendingTurn.actionProposal)
        assertTrue(runCatching { ApiContract.turn(JSONObject().put("turnId", id).put("transcript", "요청")
            .put("sentences", JSONArray()).put("actionProposalPending", JSONObject().put("actionId", id).put("version", 0))) }.isFailure)
        assertNull(ApiContract.turn(JSONObject().put("turnId", id).put("transcript", "질문")
            .put("sentences", JSONArray())).actionProposal)
    }

    @Test fun serializesProposalRequestsAndDecodesApprovalCancelAndStatus() {
        val requestId = "00000000-0000-4000-8000-000000000002"
        val request = ActionProposalRequest("trip-1", requestId, "mail_reply", "candidate-1", audio)
        val json = ActionApiContract.proposalJson(request)
        assertEquals(requestId, json.getString("requestId")); assertEquals("mail_reply", json.getString("kind"))
        assertEquals("candidate-1", json.getString("candidateId")); assertTrue(json.has("audio"))
        assertTrue(runCatching { ActionApiContract.proposalJson(request.copy(requestId = "bad")) }.isFailure)

        val holding = ActionApiContract.approval(JSONObject().put("actionId", "00000000-0000-4000-8000-000000000003")
            .put("status", "holding").put("executeAt", "2026-11-08T12:00:12Z").put("serverNow", "2026-11-08T12:00:00Z")
            .put("holdSentences", JSONArray().put(sentence("십 초 뒤에 보낼게요."))))
        assertEquals("holding", holding.status); assertEquals(1, holding.holdSentences.size)
        val cancelled = ActionApiContract.cancel(JSONObject().put("actionId", holding.actionId).put("status", "cancelled").put("cancelled", true))
        assertTrue(cancelled.cancelled)
        val status = ActionApiContract.status(JSONObject().put("actionId", holding.actionId).put("kind", "mail_reply")
            .put("status", "succeeded").put("outcomeCode", "sent").put("sentences", JSONArray().put(sentence("회신을 보냈어요."))))
        assertEquals("succeeded", status.status); assertEquals("sent", status.outcomeCode)
    }

    @Test fun privateActionPayloadsHaveRedactedDebugRepresentations() {
        val proposal = ActionApiContract.proposal(JSONObject().put("actionId", "00000000-0000-4000-8000-000000000004")
            .put("version", 1).put("status", "awaiting_approval").put("contentHash", "b".repeat(64))
            .put("sentences", JSONArray().put(sentence("가상 담당자에게 비공개 본문으로 보냅니다.")))
            .put("display", JSONObject().put("sender", "private@example.invalid").put("subject", "비공개 제목").put("body", "비공개 본문"))
            .put("expiresAt", 1794140000000L))
        val text = listOf(proposal, proposal.display, proposal.sentences.single(),
            ActionProposalRequest("trip-1", "00000000-0000-4000-8000-000000000005", "mail_reply", "private-candidate", audio)).joinToString()
        for (privateValue in listOf("private@example.invalid", "비공개 제목", "비공개 본문", "가상 담당자에게", audio.data)) {
            assertFalse("Debug representation leaked action content", text.contains(privateValue))
        }
    }
}
