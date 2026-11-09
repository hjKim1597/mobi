package dev.mobi.net

import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import java.util.Base64

class ActionApiClientTest {
    @After fun resetFixture() = ApiClientTest.config("{}")

    private fun fixtureAudio() = WavAudio(Base64.getEncoder().encodeToString(
        dev.mobi.voice.AudioClip.wav(ShortArray(1600) { 1000 })))

    @Test fun actionEndpointsUseDeviceAuthAndDecodeLifecycleResponses() {
        ApiClientTest.config("{\"actionScenario\":\"reply\"}")
        val credentials = DeviceCredentials("11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111." + "a".repeat(64))
        val audio = fixtureAudio()
        ApiClient(ApiClientTest.BASE, true).use { api ->
            val capabilities = ApiClientTest.await<Capabilities> { api.capabilities(credentials, api.deadline(), it) }.getOrThrow()
            assertTrue(capabilities.mailReply)
            val scan = ApiClientTest.await<MailScanResponse> { api.scanMail("trip-1", credentials, api.deadline(), it) }.getOrThrow()
            assertEquals("fixture-mail-1", scan.candidate?.candidateId)
            val proposal = ApiClientTest.await<ActionProposal> {
                api.proposeAction(ActionProposalRequest("trip-1", java.util.UUID.randomUUID().toString(), "mail_reply", scan.candidate!!.candidateId, audio), credentials, api.deadline(), it)
            }.getOrThrow()
            val approval = ApiClientTest.await<ActionApproval> {
                api.approveAction(proposal.actionId, ActionApprovalRequest(proposal.contentHash!!, proposal.version, "voice", audio), credentials, api.deadline(), it)
            }.getOrThrow()
            assertEquals("holding", approval.status)
            val cancel = ApiClientTest.await<ActionCancel> { api.cancelAction(proposal.actionId, credentials, api.deadline(), it) }.getOrThrow()
            assertTrue(cancel.cancelled)
            val status = ApiClientTest.await<ActionStatus> { api.actionStatus(proposal.actionId, credentials, api.deadline(), it) }.getOrThrow()
            assertEquals("cancelled", status.status)
        }
    }

    @Test fun calendarClarificationUsesExistingActionAndVoiceAudio() {
        ApiClientTest.config("{\"actionScenario\":\"calendar_voice\",\"needsClarification\":true}")
        val credentials = DeviceCredentials("11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111." + "a".repeat(64))
        val audio = fixtureAudio()
        ApiClient(ApiClientTest.BASE, true).use { api ->
            val proposal = ApiClientTest.await<ActionProposal> {
                api.proposeAction(ActionProposalRequest("trip-1", java.util.UUID.randomUUID().toString(), "calendar_insert", audio = audio), credentials, api.deadline(), it)
            }.getOrThrow()
            val clarified = ApiClientTest.await<ActionProposal> {
                api.clarifyAction(proposal.actionId, proposal.version, audio, credentials, api.deadline(), it)
            }.getOrThrow()
            assertEquals(proposal.actionId, clarified.actionId)
            assertEquals("회의 시간 확인", clarified.display.title)
        }
        ApiClientTest.config("{}")
    }
}
