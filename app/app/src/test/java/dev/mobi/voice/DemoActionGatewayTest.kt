package dev.mobi.voice

import dev.mobi.net.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class DemoActionGatewayTest {
    private var now=1000L
    private val audio=WavAudio(Base64.getEncoder().encodeToString(AudioClip.wav(ShortArray(16000))))
    private val gateway=DemoActionGateway({audio},{now})
    private fun proposal(kind: String="mail_reply"): ActionProposal {
        var result: ActionProposal?=null
        gateway.propose(ActionProposalRequest("demo-trip","request",kind,"demo-mail")) { result=it.getOrThrow() }
        return result!!
    }
    @Test fun localReplyWaitsForApprovalAndRealHoldBeforeSuccess() {
        val p=proposal(); var status=""
        gateway.status(p.actionId) { status=it.getOrThrow().status }; assertEquals("awaiting_approval",status)
        var approval: ActionApproval?=null
        gateway.approve(p.actionId,ActionApprovalRequest(p.contentHash!!,1,"parked_button")) { approval=it.getOrThrow() }
        assertTrue(approval!!.executeAt!!-now>=12000)
        now=approval!!.executeAt!!-1; gateway.status(p.actionId) { status=it.getOrThrow().status }; assertEquals("holding",status)
        now++; gateway.status(p.actionId) { val result=it.getOrThrow();status=result.status;assertTrue(result.sentences!!.single().text.contains("실제 메일은 보내지 않았어요")) }
        assertEquals("succeeded",status)
    }
    @Test fun localCalendarHasAbsoluteDateAndNoExternalCalendarWrite() {
        val p=proposal("calendar_insert")
        assertTrue(p.sentences.single().text.contains(requireNotNull(p.display.title)))
        assertEquals("Asia/Seoul",p.display.timeZone);assertTrue(p.sentences.single().text.contains("2026년 11월 10일"))
        gateway.approve(p.actionId,ActionApprovalRequest(p.contentHash!!,1,"parked_button")) {}
        gateway.cancel(p.actionId) { assertTrue(it.getOrThrow().cancelled) }
        now+=50000
        gateway.status(p.actionId) { val state=it.getOrThrow(); assertEquals("cancelled",state.status); assertEquals("일정을 추가하지 않았어요.",state.sentences!!.single().text) }
    }
    @Test fun demoGatewayCanReadBackTheProposalItStored() {
        val p = proposal("calendar_insert"); var result: ActionProposal? = null
        gateway.readback(p.actionId) { result = it.getOrThrow() }
        assertEquals(p, result)
    }
    @Test fun localCancelUsesStageAccurateNoWriteSentence() {
        val reply=proposal(); gateway.cancel(reply.actionId) {}
        gateway.status(reply.actionId) { assertEquals("보내지 않았어요.",it.getOrThrow().sentences!!.single().text) }
        val calendar=proposal("calendar_insert"); gateway.cancel(calendar.actionId) {}
        gateway.status(calendar.actionId) { assertEquals("일정을 추가하지 않았어요.",it.getOrThrow().sentences!!.single().text) }
    }
    @Test fun liveTripCannotEnterDemoGateway() {
        try { gateway.propose(ActionProposalRequest("live-trip","request","calendar_insert")) {}; fail() } catch (_:IllegalArgumentException) {}
    }
    @Test fun duplicateApprovalCannotRestartHold() {
        val p=proposal();val approval=ActionApprovalRequest(p.contentHash!!,1,"parked_button")
        gateway.approve(p.actionId,approval) {}
        try { gateway.approve(p.actionId,approval) {}; fail() } catch (_:IllegalArgumentException) {}
    }
}
