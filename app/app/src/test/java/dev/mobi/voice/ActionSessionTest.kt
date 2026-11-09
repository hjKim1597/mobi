package dev.mobi.voice

import dev.mobi.dialog.ActionStage
import dev.mobi.net.*
import dev.mobi.trip.Clock
import org.junit.Assert.*
import org.junit.Test

class ActionSessionTest {
    private class Input : VoiceInput {
        var onset: (() -> Unit)? = null
        var result: ((Result<AudioClip>) -> Unit)? = null
        var starts = 0
        var autoReady = true
        var throwOnHoldStart = false
        var holdStarts = 0
        var ready: () -> Unit = {}
        override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit, result: (Result<AudioClip>) -> Unit): CancelHandle {
            starts++
            if (mode == CaptureMode.HOLD) {
                holdStarts++
                if (throwOnHoldStart) throw IllegalStateException("PRIVATE capture exception")
            }
            onset = voiceStarted; this.result = result; return CancelHandle {}
        }
        override fun close() {}
        override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit,
            result: (Result<AudioClip>) -> Unit, ready: () -> Unit): CancelHandle {
            this.ready = ready
            return start(mode, allowed, voiceStarted, result).also { if (autoReady) ready() }
        }
    }
    private class Output : VoiceOutput {
        var done: (() -> Unit)? = null; var fail: (() -> Unit)? = null; var starts = 0
        override fun play(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit) {
            starts++; done = finished; fail = failed; started()
        }
        override fun pause() {}; override fun resume() {}; override fun stop() {}; override fun close() {}
    }
    private class Gateway : ActionGateway {
        var mail: MailCandidate? = null
        var approvals = 0; var cancels = 0; var statuses = 0; var proposals = 0; var scans = 0
        val quietScanFlags = mutableListOf<Boolean>()
        var clarifications = 0
        var cancelFailure = false
        var deferCancel = false
        var cancelCallback: ((Result<ActionCancel>) -> Unit)? = null
        var lastStatusId: String? = null
        var clarified: ((Result<ActionProposal>) -> Unit)? = null
        var readback: ((Result<ActionProposal>) -> Unit)? = null
        var approval: ((Result<ActionApproval>) -> Unit)? = null
        var status: ((Result<ActionStatus>) -> Unit)? = null
        var proposed: ((Result<ActionProposal>) -> Unit)? = null
        override fun capabilities(cb: (Result<Capabilities>) -> Unit) = CancelHandle {}.also { cb(Result.success(Capabilities(true,true,true,true,false))) }
        override fun scan(tripId: String, quiet: Boolean, cb: (Result<MailScanResponse>) -> Unit) = CancelHandle {}.also { scans++; quietScanFlags += quiet; cb(Result.success(MailScanResponse(mail))) }
        override fun propose(request: ActionProposalRequest, cb: (Result<ActionProposal>) -> Unit) = CancelHandle {}.also { proposals++; proposed = cb }
        override fun readback(id: String, cb: (Result<ActionProposal>) -> Unit) = CancelHandle {}.also { readback = cb }
        override fun clarify(id: String, version: Int, audio: WavAudio, cb: (Result<ActionProposal>) -> Unit) = CancelHandle {}.also { clarifications++; clarified=cb }
        override fun approve(id: String, request: ActionApprovalRequest, cb: (Result<ActionApproval>) -> Unit) = CancelHandle {}.also { approvals++; approval = cb }
        override fun cancel(id: String, cb: (Result<ActionCancel>) -> Unit) = CancelHandle {}.also {
            cancels++
            val result = if (cancelFailure) Result.failure(IllegalStateException("lost cancel response")) else Result.success(ActionCancel(id,"cancelled",true))
            if (deferCancel) cancelCallback = cb else cb(result)
        }
        override fun status(id: String, cb: (Result<ActionStatus>) -> Unit) = CancelHandle {}.also { statuses++; lastStatusId = id; status = cb }
    }
    private class Rig(demo: Boolean = false, localAudioAvailable: Boolean = true) {
        var now = 1000L; var allowed = true; var focused = true; var saved: String? = null; var quietMail = false
        var diagnosticThrows = false
        val diagnostics = mutableListOf<String>()
        val localKeys = mutableListOf<String>()
        val timers = mutableListOf<Pair<Long,()->Unit>>()
        val input = Input(); val output = Output(); val gateway = Gateway()
        val session = ActionSession(Clock { now }, { now }, gateway, input, output,
            { delay, fn -> (now+delay to fn).let { timers.add(it); CancelHandle { timers.remove(it) } } },
            { it() }, { allowed }, { focused }, {}, { saved = it }, { "trip-$it" }, { key -> localKeys += key; if (localAudioAvailable) WavAudio("local") else null }, demo = demo,
            quietMail = { quietMail }, diagnostic = {
                diagnostics += it
                if (diagnosticThrows) throw IllegalStateException("PRIVATE logger exception")
            })
        fun advance(ms: Long) { now += ms; timers.toList().filter { it.first <= now }.forEach { timers.remove(it); it.second() } }
        fun proposal(id: String="one", status: String="awaiting_approval") = ActionProposal(id,1,status,"h",listOf(Sentence("read all", WavAudio("read"))), ActionDisplay(body="all"),now+90000,null)
        fun begin() { session.begin(1,1); session.receive(proposal()); }
        fun ready() { begin(); output.done!!() }
        fun approvedHold(duration: Long = 12000) { ready(); session.approveButton(); gateway.approval!!(Result.success(ActionApproval("one","holding",now+duration,now,listOf(Sentence("hold",WavAudio("hold"))),null,null))) }
        fun holding() { approvedHold(); output.done!!() }
    }
    private fun assertCancel(r: Rig, reason: String, remaining: Long, ready: Boolean, stage: String = "HOLDING") {
        assertEquals(listOf("ACTION_CANCEL reason=$reason stage=$stage remainingMs=$remaining holdReady=$ready"),
            r.diagnostics.filter { it.startsWith("ACTION_CANCEL ") })
        assertEquals(1, r.gateway.cancels)
        assertFalse(r.diagnostics.joinToString().contains("PRIVATE"))
    }
    @Test fun cancelDiagnosticsDistinguishPermissionFromFocusBeforeHoldCaptureStarts() {
        for (permission in listOf(true, false)) {
            val r = Rig(); r.approvedHold()
            if (permission) r.allowed = false else r.focused = false
            r.output.done!!()
            assertCancel(r, if (permission) "permission" else "focus", 12000, false)
            assertFalse(r.diagnostics.contains("HOLD_LISTEN_START"))
            assertEquals(0, r.input.holdStarts)
        }
    }
    @Test fun cancelDiagnosticsCoverImmediateAndScheduledUnreadyWatchdogs() {
        val immediate = Rig(); immediate.approvedHold(1000)
        assertCancel(immediate, "watchdog_unready", 1000, false)
        assertFalse(immediate.diagnostics.contains("HOLD_LISTEN_START"))
        val scheduled = Rig(); scheduled.input.autoReady = false; scheduled.holding()
        scheduled.advance(10500)
        assertCancel(scheduled, "watchdog_unready", 1500, false)
        scheduled.input.ready(); scheduled.input.onset!!()
        assertCancel(scheduled, "watchdog_unready", 1500, false)
    }
    @Test fun cancelDiagnosticsCoverShortWindowAfterSpeechAndInReadyCallback() {
        val afterSpeech = Rig(); afterSpeech.approvedHold(); afterSpeech.advance(2001); afterSpeech.output.done!!()
        assertCancel(afterSpeech, "window_short", 9999, false)
        assertEquals(0, afterSpeech.input.holdStarts)
        val afterStart = Rig(); afterStart.input.autoReady = false; afterStart.holding()
        afterStart.advance(2001); afterStart.input.ready()
        assertCancel(afterStart, "window_short", 9999, false)
        assertEquals(1, afterStart.input.holdStarts)
    }
    @Test fun cancelDiagnosticsCoverPermissionLostBeforeReady() {
        val r = Rig(); r.input.autoReady = false; r.holding(); r.allowed = false; r.input.ready()
        assertCancel(r, "permission", 12000, false)
    }
    @Test fun cancelDiagnosticsCoverOnsetBeforeReadyAndVoicedResultAfterReady() {
        val onset = Rig(); onset.input.autoReady = false; onset.holding()
        val staleResult = onset.input.result!!
        onset.input.onset!!()
        val bytes = AudioClip.wav(ShortArray(320))
        staleResult(Result.success(AudioClip(bytes, onset.now, true)))
        assertTrue(bytes.all { it == 0.toByte() })
        assertCancel(onset, "voice_onset", 12000, false)
        val voiced = Rig(); voiced.holding()
        voiced.input.result!!(Result.success(AudioClip(AudioClip.wav(ShortArray(320)), voiced.now, true)))
        assertCancel(voiced, "voice_onset", 12000, true)
    }
    @Test fun cancelDiagnosticsCoverCaptureFailureAndStartExceptionWithoutPrivateDetails() {
        val failed = Rig(); failed.input.autoReady = false; failed.holding()
        failed.input.result!!(Result.failure(IllegalStateException("PRIVATE capture failure")))
        assertCancel(failed, "capture_failed", 12000, false)
        val thrown = Rig(); thrown.input.throwOnHoldStart = true; thrown.holding()
        assertCancel(thrown, "capture_exception", 12000, false)
        assertEquals(1, thrown.diagnostics.count { it == "HOLD_LISTEN_START" })
    }
    @Test fun cancelDiagnosticsCoverUserAndOtherWithoutDuplicateCancellationLogs() {
        val user = Rig(); user.holding(); user.session.cancel(); user.session.cancel()
        assertCancel(user, "user", 12000, true)
        val other = Rig(); other.ready(); other.advance(6000)
        assertCancel(other, "other", -1, false, "AWAITING_APPROVAL")
    }
    @Test fun holdListenStartMarkerMatchesActualStartsIncludingRestartAndThrowingLoggerIsHarmless() {
        val r = Rig(); r.diagnosticThrows = true; r.holding()
        assertEquals("LISTENING", r.session.voicePhase)
        r.input.result!!(Result.success(AudioClip(AudioClip.wav(ShortArray(320)), r.now, false)))
        assertEquals(2, r.input.holdStarts)
        assertEquals(r.input.holdStarts, r.diagnostics.count { it == "HOLD_LISTEN_START" })
        r.session.cancel()
        assertCancel(r, "user", 12000, true)
    }
    @Test fun supersedingAnActiveActionLogsOneAutomaticCancelBeforeResettingHoldState() {
        val r = Rig(); r.holding(); r.session.begin(2, 1)
        assertCancel(r, "other", 12000, true)
    }
    private fun openCalendarFollowup(r: Rig) {
        val audio = WavAudio("offer")
        r.gateway.mail = MailCandidate("candidate", false, true, true,
            listOf(Sentence("회신 내용을 작성할까요?", audio)), listOf(Sentence("답장을 말해 주세요", audio)),
            listOf(Sentence("일정 내용을 확인할까요?", audio)), ActionDisplay())
        r.session.offerConfirm = { _, cb -> cb(Result.success(ConfirmResponse("응", ConfirmMatch("응", "LISTEN", "exact")))); CancelHandle {} }
        r.session.begin(60, 1); r.session.afterBriefing(900)
        r.output.done!!()
        r.input.result!!(Result.success(AudioClip(AudioClip.wav(ShortArray(320)), r.now, true)))
        r.output.done!!()
        r.input.result!!(Result.success(AudioClip(AudioClip.wav(ShortArray(320)), r.now, true)))
        r.gateway.proposed!!(Result.success(r.proposal("reply")))
        r.output.done!!(); r.session.approveButton()
        r.gateway.approval!!(Result.success(ActionApproval("reply", "holding", r.now + 14000, r.now,
            listOf(Sentence("hold", audio)), null, null)))
        r.output.done!!(); r.advance(14000)
        r.gateway.status!!(Result.success(ActionStatus("reply", "mail_reply", "succeeded", null, null, listOf(Sentence("sent", audio)))))
        r.output.done!!(); r.output.done!!()
    }
    @Test fun mailScanReadsTripQuietSettingAtRequestTime() {
        val r = Rig()
        r.session.begin(1, 1)
        r.session.afterBriefing(900)
        assertEquals(listOf(false), r.gateway.quietScanFlags)

        r.quietMail = true
        r.session.begin(2, 1)
        r.session.afterBriefing(900)
        assertEquals(listOf(false, true), r.gateway.quietScanFlags)
    }

    @Test fun quietMailSettingDefaultsOffAndResetsWhenDrivingTripEnds() {
        val setting = dev.mobi.trip.QuietMailSetting()
        assertFalse(setting.enabled)
        setting.set(true, 0)
        setting.onGear(dev.mobi.vehicle.Gear.DRIVE, 1)
        assertTrue(setting.enabled)
        val parkedAt = 5L
        assertEquals(parkedAt, setting.onGear(dev.mobi.vehicle.Gear.PARK, parkedAt))
        assertTrue(setting.enabled)
        assertFalse(setting.finishTrip(parkedAt, parkedAt + 599_999))
        setting.onGear(dev.mobi.vehicle.Gear.DRIVE, parkedAt + 599_999)
        assertTrue("A short stop is still the same trip", setting.enabled)
        val arrivedAt = parkedAt + 600_000
        val nextParkedAt = setting.onGear(dev.mobi.vehicle.Gear.PARK, arrivedAt)!!
        assertTrue(setting.finishTrip(nextParkedAt, arrivedAt + 600_000))
        assertFalse(setting.enabled)

        setting.set(true, arrivedAt + 600_001)
        setting.onGear(dev.mobi.vehicle.Gear.DRIVE, arrivedAt + 600_002)
        assertTrue("A new parked choice carries into the next trip", setting.enabled)
    }

    @Test fun quietMailScanPlaysFixedNoticeAndKeepsDisplayOnlyForParkedResult() {
        val r = Rig().apply { quietMail = true }
        val audio = WavAudio("notice")
        r.gateway.mail = MailCandidate("mail-1", false, false, false,
            listOf(Sentence("확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.", audio)), emptyList(), emptyList(),
            ActionDisplay(sender = "보낸 사람", subject = "제목", summary = "요약"))
        r.session.begin(1, 1)
        r.session.afterBriefing(900)
        assertEquals(ActionStage.RESULT, r.session.dialog.stage)
        assertTrue(r.session.quietMailNotice)
        assertEquals(0, r.input.starts)
        assertEquals(0, r.gateway.proposals)
        r.output.done!!()
        assertEquals("제목", r.session.candidate?.display?.subject)
        assertEquals("확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.", r.session.resultText)

        r.session.receive(r.proposal("calendar"))
        assertFalse(r.session.quietMailNotice)
        assertNull(r.session.candidate)
    }

    @Test fun quietMailScanFailsClosedIfServerReturnsPrivateSpeech() {
        val r = Rig().apply { quietMail = true }
        r.gateway.mail = MailCandidate("mail-1", false, true, false,
            listOf(Sentence("보낸 사람과 제목을 읽어요", WavAudio("private"))), emptyList(), emptyList(),
            ActionDisplay(sender = "개인 발신자", subject = "개인 제목"))
        r.session.begin(1, 1)
        r.session.afterBriefing(900)
        assertEquals(ActionStage.IDLE, r.session.dialog.stage)
        assertEquals(0, r.output.starts)
        assertEquals(0, r.input.starts)
        assertNull(r.session.candidate)
    }

    @Test fun pendingCalendarReadbackFailureCannotRestoreOldQuietMailCard() {
        val r = Rig().apply { quietMail = true }
        r.gateway.mail = MailCandidate("mail-1", false, false, false,
            listOf(Sentence("확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.", WavAudio("notice"))), emptyList(), emptyList(),
            ActionDisplay(sender = "보낸 사람", subject = "제목", summary = "요약"))
        r.session.begin(1, 1)
        r.session.afterBriefing(900)
        r.output.done!!()
        assertTrue(r.session.quietMailNotice)

        r.session.receivePending("00000000-0000-4000-8000-000000000009", 1, 1, 1)
        assertFalse(r.session.quietMailNotice)
        assertNull(r.session.candidate)
        r.gateway.readback!!(Result.failure(IllegalStateException("readback unavailable")))
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
        assertNull(r.session.candidate)
    }

    @Test fun handleReturnedWithoutRecorderReadyCancelsAtWatchdogBeforeAnyPoll() {
        val r = Rig(); r.input.autoReady = false; r.holding()
        assertEquals(ActionStage.HOLDING, r.session.dialog.stage)
        r.advance(10499); assertEquals(0, r.gateway.cancels)
        r.advance(1)
        assertEquals(1, r.gateway.cancels)
        assertEquals("cancelled", r.session.outcome)
        r.advance(1500); r.input.ready()
        assertEquals(0, r.gateway.statuses)
        assertEquals(ActionStage.RESULT, r.session.dialog.stage)
    }
    @Test fun delayedRecorderReadyWithLessThanTenSecondsRemainingCancelsImmediately() {
        val r = Rig(); r.input.autoReady = false; r.holding()
        r.advance(2001); r.input.ready()
        assertEquals(1, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals("cancelled", r.session.outcome)
    }
    @Test fun actualRecorderReadyOpensTenSecondWindowAndThenPollsWithoutCancelling() {
        val r = Rig(); r.input.autoReady = false; r.holding()
        assertNotEquals("LISTENING", r.session.voicePhase)
        r.advance(2000); r.input.ready() // Exactly ten seconds still remain.
        assertEquals("LISTENING", r.session.voicePhase)
        r.advance(9999)
        assertEquals(0, r.gateway.cancels); assertEquals(0, r.gateway.statuses)
        r.advance(1)
        assertEquals(0, r.gateway.cancels); assertEquals(1, r.gateway.statuses)
    }
    @Test fun recorderFailureBeforeReadyCancelsWithoutPolling() {
        val r = Rig(); r.input.autoReady = false; r.holding()
        r.input.result!!(Result.failure(IllegalStateException("start failed")))
        assertEquals(1, r.gateway.cancels); assertEquals("cancelled", r.session.outcome)
        r.advance(12000); assertEquals(0, r.gateway.statuses)
    }
    @Test fun restartedCaptureMustBecomeReadyAndOldReadyCannotDisarmItsWatchdog() {
        val r = Rig(); r.holding(); val staleReady = r.input.ready
        r.input.autoReady = false; r.advance(1000)
        val bytes = AudioClip.wav(ShortArray(320))
        r.input.result!!(Result.success(AudioClip(bytes, r.now, false)))
        assertTrue(bytes.all { it == 0.toByte() })
        staleReady()
        r.advance(9499); assertEquals(0, r.gateway.cancels)
        r.advance(1)
        assertEquals(1, r.gateway.cancels); assertEquals("cancelled", r.session.outcome)
        r.advance(1500); assertEquals(0, r.gateway.statuses)
    }
    @Test fun restartedCaptureReadyTooLateCancelsInsteadOfUsingEarlierReadyTime() {
        val r = Rig(); r.holding(); r.input.autoReady = false
        r.advance(3000)
        r.input.result!!(Result.success(AudioClip(AudioClip.wav(ShortArray(320)), r.now, false)))
        r.input.ready()
        assertEquals(1, r.gateway.cancels); assertEquals(0, r.gateway.statuses)
        assertEquals("cancelled", r.session.outcome)
    }
    @Test fun unknownLiveActionSurvivesDemoSuspendAndResumesStatusOnly() {
        val r = Rig(); r.holding(); r.gateway.cancelFailure = true; r.session.cancel()
        assertEquals(ActionStage.UNKNOWN, r.session.dialog.stage)
        assertEquals("one", r.saved)
        val approvals = r.gateway.approvals; val cancels = r.gateway.cancels
        r.session.suspend(); r.advance(20000)
        assertEquals("one", r.saved); assertEquals(0, r.gateway.statuses)
        r.session.resume()
        assertEquals(1, r.gateway.statuses); assertEquals("one", r.gateway.lastStatusId)
        r.session.approveButton()
        assertEquals(approvals, r.gateway.approvals); assertEquals(cancels, r.gateway.cancels)
        r.gateway.status!!(Result.success(ActionStatus("one", "mail_reply", "succeeded", null, null, emptyList())))
        assertNull(r.saved); assertEquals("succeeded", r.session.outcome)
    }
    @Test fun nonTerminalLiveActionsSurviveDemoSuspendAndResumeOnlyStatus() {
        for (holding in listOf(false, true)) {
            val r = Rig(); if (holding) r.holding() else r.ready()
            val approvals = r.gateway.approvals
            r.session.suspend(); assertEquals("one", r.saved)
            r.session.resume(); r.session.approveButton()
            assertEquals(1, r.gateway.statuses); assertEquals("one", r.gateway.lastStatusId)
            assertEquals(approvals, r.gateway.approvals); assertEquals(0, r.gateway.cancels)
        }
    }
    @Test fun serverUnknownStatusKeepsRecoveryIdAcrossDemoUntilResolved() {
        val r = Rig(); r.session.restore("one")
        r.gateway.status!!(Result.success(ActionStatus("one", "mail_reply", "unknown", null, null, emptyList())))
        assertEquals("one", r.saved)
        r.session.suspend(); r.session.resume()
        assertEquals(2, r.gateway.statuses); assertEquals("one", r.gateway.lastStatusId)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun resolvedLiveActionDoesNotResumeOrRetainAnIdAfterDemo() {
        val r = Rig(); r.holding(); r.session.cancel()
        assertNull(r.saved)
        r.session.suspend(); r.session.resume()
        assertEquals(0, r.gateway.statuses); assertEquals(1, r.gateway.approvals)
    }
    @Test fun liveThreeSecondAnnouncementWithLegacyDeadlineCancelsInsteadOfShorteningListening() {
        val r = Rig(); r.ready(); r.session.approveButton()
        val startsBeforeHold = r.input.starts
        r.gateway.approval!!(Result.success(ActionApproval("one", "holding", r.now + 12000, r.now,
            listOf(Sentence("hold", WavAudio("hold"))), null, null)))
        r.advance(3000); r.output.done!!()
        assertEquals(1, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals(startsBeforeHold, r.input.starts)
        assertEquals(ActionStage.RESULT, r.session.dialog.stage)
        assertEquals("cancelled", r.session.outcome)
    }
    @Test fun liveThirteenSecondAnnouncementCancelsBeforeExecutionWithoutPollingOrListening() {
        val r = Rig(); r.ready(); r.session.approveButton()
        val startsBeforeHold = r.input.starts
        r.gateway.approval!!(Result.success(ActionApproval("one", "holding", r.now + 12000, r.now,
            listOf(Sentence("hold", WavAudio("hold"))), null, null)))
        val lateCompletion = r.output.done!!
        r.advance(10499)
        assertEquals(0, r.gateway.cancels)
        r.advance(1) // Independent watchdog: 1.5 seconds before the server alarm.
        assertEquals(1, r.gateway.cancels)
        assertEquals("cancelled", r.session.outcome)
        r.advance(2500); lateCompletion()
        assertEquals(1, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals(startsBeforeHold, r.input.starts)
        assertEquals(ActionStage.RESULT, r.session.dialog.stage)
    }
    @Test fun liveThreeSecondAnnouncementWithNewDeadlineListensForElevenSecondsThenPolls() {
        val r = Rig(); r.ready(); r.session.approveButton()
        val startsBeforeHold = r.input.starts
        r.gateway.approval!!(Result.success(ActionApproval("one", "holding", r.now + 14000, r.now,
            listOf(Sentence("hold", WavAudio("hold"))), null, null)))
        r.advance(3000); r.output.done!!()
        assertEquals(startsBeforeHold + 1, r.input.starts)
        assertEquals("LISTENING", r.session.voicePhase)
        r.advance(10999) // Cross the watchdog cutoff with cancellation listening active.
        assertEquals(0, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals(ActionStage.HOLDING, r.session.dialog.stage)
        r.advance(1)
        assertEquals(1, r.gateway.statuses)
        assertEquals(0, r.gateway.cancels)
        assertEquals(ActionStage.PROCESSING, r.session.dialog.stage)
        assertNull(r.session.outcome)
    }
    @Test fun holdWatchdogUsesServerTimeAndDeductsApprovalRoundTripDelay() {
        val r = Rig(); r.ready(); r.session.approveButton()
        val serverNow = 9000000L // Unrelated to local monotonic or wall time.
        r.advance(2000)
        r.gateway.approval!!(Result.success(ActionApproval("one", "holding", serverNow + 14000, serverNow,
            listOf(Sentence("hold", WavAudio("hold"))), null, null)))
        r.advance(10499)
        assertEquals(0, r.gateway.cancels)
        r.advance(1)
        assertEquals(1, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals("cancelled", r.session.outcome)
    }
    @Test fun approvalArrivingAfterWatchdogCutoffCancelsImmediately() {
        val r = Rig(); r.ready(); r.session.approveButton()
        val serverNow = 9000000L
        r.advance(13000)
        r.gateway.approval!!(Result.success(ActionApproval("one", "holding", serverNow + 14000, serverNow,
            listOf(Sentence("hold", WavAudio("hold"))), null, null)))
        assertEquals(1, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals("cancelled", r.session.outcome)
    }
    @Test fun staleHoldWatchdogCannotCancelTheNextTrip() {
        val r = Rig(); r.ready(); r.session.approveButton()
        r.gateway.approval!!(Result.success(ActionApproval("one", "holding", r.now + 14000, r.now,
            listOf(Sentence("hold", WavAudio("hold"))), null, null)))
        r.session.begin(2, 1)
        val cancels = r.gateway.cancels
        r.advance(14000)
        assertEquals(cancels, r.gateway.cancels)
        assertEquals(0, r.gateway.statuses)
        assertEquals(ActionStage.IDLE, r.session.dialog.stage)
    }
    @Test fun approvalButtonWaitsForReadbackAndDoubleTapDoesNotReapprove() {
        val r=Rig(); r.begin(); r.session.approveButton(); assertEquals(0,r.gateway.approvals)
        r.output.done!!(); r.session.approveButton(); r.session.approveButton(); assertEquals(1,r.gateway.approvals)
    }
    @Test fun speechOnsetCancelsHoldingBeforeRecognitionAndNeverUploadsTheClip() {
        val r=Rig(); r.holding(); val clip=r.input.result!!
        r.input.onset!!(); assertEquals(1,r.gateway.cancels)
        val bytes=AudioClip.wav(ShortArray(1600)); clip(Result.success(AudioClip(bytes,r.now,true)))
        assertTrue(bytes.all { it==0.toByte() }); assertEquals(1,r.gateway.approvals); assertEquals(0,r.gateway.proposals)
    }
    @Test fun holdButtonCancellationNeedsAcknowledgement() {
        val r=Rig(); r.holding(); r.session.cancel(); assertEquals(1,r.gateway.cancels)
        assertEquals("cancelled",r.session.outcome)
    }
    @Test fun approvalTimeoutDoesNotSendAndCancelsPendingAction() {
        val r=Rig(); r.ready(); r.advance(6000); assertEquals(0,r.gateway.approvals); assertEquals(1,r.gateway.cancels)
    }
    @Test fun notApprovedCannotBeReapproved() {
        val r=Rig(); r.ready(); r.session.approveButton()
        r.gateway.approval!!(Result.success(ActionApproval("one","not_approved",null,null,emptyList(),"verb",listOf(Sentence("no",WavAudio("no"))))))
        r.session.approveButton(); assertEquals(1,r.gateway.approvals); assertEquals("not_approved",r.session.outcome)
    }
    @Test fun emptyTerminalSentencesUseStageCorrectTextAndAudioKeysEvenWithoutLocalFiles() {
        val cases = listOf(
            Triple("mail_reply", "cancelled", "보내지 않았어요."),
            Triple("mail_reply", "not_approved", "보내지 않았어요."),
            Triple("calendar_insert", "expired", "일정을 추가하지 않았어요."),
            Triple("calendar_insert", "failed", "일정을 추가하지 못했어요."),
            Triple("calendar_insert", "unknown", "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요."),
            Triple("mail_reply", "unknown", "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요.")
        )
        cases.forEach { (kind, status, expected) ->
            val r = Rig(localAudioAvailable = false)
            r.session.restore("one")
            r.gateway.status!!(Result.success(ActionStatus("one", kind, status, null, null, emptyList())))
            assertEquals(status, r.session.outcome)
            assertEquals(expected, r.session.resultText)
            assertEquals(0, r.output.starts)
            assertTrue(r.localKeys.contains(when (status) {
                "unknown" -> if (kind == "calendar_insert") "unknown_calendar" else "unknown"
                "failed" -> "failed_calendar"
                else -> if (kind == "calendar_insert") "not_written_calendar" else "not_written_reply"
            }))
            assertEquals(if (status == "unknown") ActionStage.UNKNOWN else ActionStage.RESULT, r.session.dialog.stage)
        }
    }
    @Test fun acceptedOfferOnlyStartsProposalFlowAndNeverApproves() {
        listOf("응", "네").forEachIndexed { index, word ->
            val r = Rig()
            r.gateway.mail = MailCandidate("candidate", false, true, true,
                listOf(Sentence("회신 내용을 작성할까요?", WavAudio("offer"))),
                listOf(Sentence("말해 주세요", WavAudio("prompt"))),
                listOf(Sentence("일정 내용을 확인할까요?", WavAudio("calendar"))), ActionDisplay())
            r.session.offerConfirm = { _, cb -> cb(Result.success(ConfirmResponse(word, ConfirmMatch(word, "LISTEN", "exact")))); CancelHandle {} }
            r.session.begin(index.toLong() + 10, 1)
            r.session.afterBriefing(900)
            r.output.done!!()
            val wav = AudioClip.wav(ShortArray(320))
            r.input.result!!(Result.success(AudioClip(wav, r.now, true)))
            r.output.done!!()
            val dictation = AudioClip.wav(ShortArray(320))
            r.input.result!!(Result.success(AudioClip(dictation, r.now, true)))
            assertEquals(1, r.gateway.proposals)
            assertEquals(0, r.gateway.approvals)
            r.gateway.proposed!!(Result.success(r.proposal("offer-$index")))
            assertEquals(ActionStage.READBACK, r.session.dialog.stage)
        }
    }
    @Test fun pendingCalendarReadbackFailureShowsNoWriteTextWhenAudioIsMissing() {
        val r = Rig(localAudioAvailable = false)
        r.session.begin(50, 1)
        r.session.receivePending("pending", 1, 50, 1)
        r.gateway.readback!!(Result.failure(IllegalStateException("unavailable")))
        assertEquals("failed", r.session.outcome)
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun preApprovalCancelTransportFailureIsNoWriteNotUnknown() {
        val r = Rig(); r.ready(); r.gateway.cancelFailure = true
        r.session.cancel()
        assertNotEquals(ActionStage.UNKNOWN, r.session.dialog.stage)
        assertEquals("보내지 않았어요.", r.session.resultText)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun newTripResetsActionKindBeforeAnyProposalExists() {
        val r = Rig(); r.session.begin(69, 1)
        r.session.receive(ActionProposal("old-calendar", 1, "awaiting_approval", "hash",
            listOf(Sentence("calendar", WavAudio("readback"))), ActionDisplay(title = "회의"), r.now + 90000, null))
        r.session.begin(70, 1)
        r.session.cancel()
        assertEquals("보내지 않았어요.", r.session.resultText)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun expiredCalendarProposalUsesCalendarNoWriteFallbackBeforeAnyPriorKind() {
        val r = Rig(); r.session.begin(71, 1)
        r.session.receive(ActionProposal("expired-calendar", 1, "awaiting_approval", "hash",
            emptyList(), ActionDisplay(title = "회의"), r.now, null))
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun emptyDisplayDuringCalendarClarificationKeepsCalendarNoWriteFallback() {
        val r = Rig(); r.session.begin(72, 1)
        r.session.receivePending("calendar-clarify", 1, 72, 1)
        r.gateway.readback!!(Result.success(ActionProposal("calendar-clarify", 1, "needs_clarification", "hash",
            listOf(Sentence("시간을 확인해 주세요", WavAudio("clarify"))), ActionDisplay(), r.now + 90000, null)))
        r.session.clarify(WavAudio("clarification"))
        r.gateway.clarified!!(Result.failure(IllegalStateException("clarification failed")))
        assertEquals("cancelled", r.session.outcome)
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun directCalendarTurnHintSurvivesEmptyDisplayClarificationFailure() {
        val r = Rig(); r.session.begin(73, 1)
        r.session.receive(ActionProposal("turn-calendar", 1, "needs_clarification", "hash",
            listOf(Sentence("시간을 확인해 주세요", WavAudio("clarify"))), ActionDisplay(), r.now + 90000, null),
            kindHint = "calendar_insert")
        r.session.clarify(WavAudio("clarification"))
        r.gateway.clarified!!(Result.failure(IllegalStateException("clarification failed")))
        assertEquals("cancelled", r.session.outcome)
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun successfulReplyFollowUpStartsFreshCalendarBoundary() {
        val r = Rig()
        openCalendarFollowup(r)
        assertNull(r.session.dialog.actionId)
        r.session.acceptOffer(calendar = true)
        r.gateway.proposed!!(Result.success(ActionProposal("calendar", 1, "awaiting_approval", "hash",
            listOf(Sentence("readback", WavAudio("offer"))), ActionDisplay(title = "회의"), r.now + 90000, null)))
        r.gateway.cancelFailure = true; r.session.cancel()
        assertEquals("failed", r.session.outcome)
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
        assertNotEquals(ActionStage.UNKNOWN, r.session.dialog.stage)
        assertEquals(1, r.gateway.approvals)
    }
    @Test fun cancellingCalendarFollowupOfferCannotCancelOrRepollCompletedReply() {
        val r = Rig(); openCalendarFollowup(r)
        val cancels = r.gateway.cancels; val statuses = r.gateway.statuses; val proposals = r.gateway.proposals
        assertNull(r.session.dialog.actionId)
        r.session.cancel()
        assertEquals(cancels, r.gateway.cancels)
        assertEquals(statuses, r.gateway.statuses)
        assertEquals(proposals, r.gateway.proposals)
        assertEquals("declined", r.session.outcome)
        assertEquals("일정을 추가하지 않았어요.", r.session.resultText)
    }
    @Test fun stalePreApprovalCleanupCancelCannotReplaceNewTripState() {
        val r = Rig(); r.session.begin(51, 1); r.session.receive(r.proposal(status = "needs_clarification"))
        r.gateway.deferCancel = true
        r.session.clarify(WavAudio("clarification"))
        r.gateway.clarified!!(Result.failure(IllegalStateException("clarification failed")))
        val staleCancel = r.gateway.cancelCallback!!
        r.session.begin(52, 1)
        staleCancel(Result.success(ActionCancel("one", "cancelled", true)))
        assertEquals(52L, r.session.dialog.tripId)
        assertEquals(ActionStage.IDLE, r.session.dialog.stage)
        assertNull(r.session.outcome)
        assertEquals(0, r.gateway.approvals)
    }
    @Test fun restoredUnknownKindUsesGenericNoRetryWordingUntilStatusIdentifiesKind() {
        val r = Rig(); r.session.restore("one")
        r.gateway.status!!(Result.failure(IllegalStateException("offline")))
        repeat(24) { r.advance(1000); r.gateway.status!!(Result.failure(IllegalStateException("offline"))) }
        assertEquals(ActionStage.UNKNOWN, r.session.dialog.stage)
        assertEquals("처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 처리하지 않을게요.", r.session.resultText)
        assertEquals("one", r.saved)
        assertEquals(0, r.gateway.approvals)
        assertTrue(r.localKeys.contains("unknown_generic"))
    }
    @Test fun staleReadbackAfterTripChangeCannotEnableApproval() {
        val r=Rig(); r.begin(); val late=r.output.done!!; r.session.begin(2,1); late(); r.session.approveButton()
        assertEquals(0,r.gateway.approvals)
    }
    @Test fun staleApprovalFromOtherActionIsDropped() {
        val r=Rig(); r.ready(); r.session.approveButton()
        r.gateway.approval!!(Result.success(ActionApproval("other","holding",r.now+12000,r.now,emptyList(),null,null)))
        assertNotEquals(ActionStage.HOLDING,r.session.dialog.stage)
    }
    @Test fun drivingWithoutMicCancelsButDrivingWithMicCanContinueVoice() {
        val r=Rig(); r.ready(); r.allowed=false; r.session.safetyChanged(); assertEquals(1,r.gateway.cancels)
        val v=Rig(); v.ready(); v.session.safetyChanged(); assertEquals(0,v.gateway.cancels)
    }
    @Test fun restartQueriesOnlyStatusAndNeverApproves() {
        val r=Rig(); r.session.begin(1,1); r.session.restore("one"); assertEquals(1,r.gateway.statuses)
        r.session.approveButton(); assertEquals(0,r.gateway.approvals)
        r.gateway.status!!(Result.success(ActionStatus("one","mail_reply","holding",r.now+12000,null,null)))
        r.advance(1000); assertEquals(0,r.gateway.approvals); assertTrue(r.gateway.statuses>=2)
    }
    @Test fun resultIsNotInferredFromHoldCountdown() {
        val r=Rig(); r.holding(); r.advance(12000); assertEquals(1,r.gateway.statuses)
        assertNull(r.session.outcome)
    }
    @Test fun interruptedReadbackDoesNotApprove() {
        val r=Rig(); r.begin(); r.output.fail!!(); r.session.approveButton(); assertEquals(0,r.gateway.approvals)
    }
    @Test fun shortRouteSkipsScanAndOfferIsAtMostOncePerTrip() {
        val r=Rig(); r.session.begin(1,1); r.session.afterBriefing(299); assertEquals(0,r.gateway.scans)
        r.session.afterBriefing(300); r.session.afterBriefing(900); assertEquals(1,r.gateway.scans)
    }
    @Test fun calendarFollowUpBindsANewActionAfterReplySuccess() {
        val r=Rig()
        val line=listOf(Sentence("offer",WavAudio("offer")))
        r.gateway.mail=MailCandidate("mail",false,true,true,line,line,line,ActionDisplay(sender="sender"))
        r.session.begin(1,1);r.session.afterBriefing(900)
        r.session.receive(r.proposal());r.output.done!!();r.session.approveButton()
        r.gateway.approval!!(Result.success(ActionApproval("one","holding",r.now+12000,r.now,line,null,null)))
        r.output.done!!();r.advance(12000)
        r.gateway.status!!(Result.success(ActionStatus("one","mail_reply","succeeded",null,null,line)))
        r.output.done!!();assertEquals(ActionStage.OFFER,r.session.dialog.stage)
        r.session.acceptOffer(true)
        r.gateway.proposed!!(Result.success(r.proposal("two")))
        assertEquals("two",r.session.dialog.actionId)
        assertEquals(ActionStage.READBACK,r.session.dialog.stage)
    }
    @Test fun lostApprovalResponseCancelsBeforeAnyStatusPollingOrExecution() {
        val r=Rig();r.ready();r.session.approveButton()
        r.gateway.approval!!(Result.failure(ApiFailure(0,"TIMEOUT")))
        assertEquals(1,r.gateway.cancels);assertEquals(0,r.gateway.statuses)
        assertEquals("cancelled",r.session.outcome)
    }
    @Test fun emptyReadbackCannotOpenApproval() {
        val r=Rig();r.session.begin(1,1);r.session.receive(r.proposal().copy(sentences=emptyList()))
        r.session.approveButton();assertEquals(0,r.gateway.approvals)
        assertFalse(r.session.readbackFinished)
    }
    @Test fun pendingCalendarFetchesReadbackThenEnablesNormalApprovalOnlyForMatchingVersion() {
        val r = Rig(); r.session.begin(7, 3)
        r.session.receivePending("pending", 4, 7, 3)
        assertEquals("pending", r.session.dialog.actionId); assertEquals(0, r.gateway.approvals)
        assertNotNull(r.gateway.readback)
        val p = r.proposal("pending").copy(version = 4)
        r.gateway.readback!!(Result.success(p))
        assertEquals(ActionStage.READBACK, r.session.dialog.stage)
        r.session.approveButton(); assertEquals(0, r.gateway.approvals)
        r.output.done!!(); assertEquals(ActionStage.AWAITING_APPROVAL, r.session.dialog.stage)
        r.session.approveButton(); assertEquals(1, r.gateway.approvals)
    }
    @Test fun pendingReadbackFailureOrMismatchedIdentityEndsSafelyWithoutApproval() {
        for (response in listOf<Result<ActionProposal>?>(null, Result.failure(IllegalStateException()), Result.success(
            ActionProposal("other", 4, "awaiting_approval", "h", listOf(Sentence("read", WavAudio("read"))), ActionDisplay(title="회의"), 99999, null)),
            Result.success(ActionProposal("pending", 3, "awaiting_approval", "h", listOf(Sentence("read", WavAudio("read"))), ActionDisplay(title="회의"), 99999, null)))) {
            val r = Rig(); r.session.begin(7, 3); r.session.receivePending("pending", 4, 7, 3)
            response?.let { r.gateway.readback!!(it) }
            if (response == null) r.gateway.readback!!(Result.failure(IllegalStateException("readback failed")))
            assertEquals(ActionStage.RESULT, r.session.dialog.stage)
            assertEquals("failed", r.session.outcome); assertEquals(0, r.gateway.approvals); assertEquals(1, r.gateway.cancels)
        }
    }
    @Test fun staleTripOrGenerationPendingCallbackIsIgnored() {
        val r = Rig(); r.session.begin(7, 3); r.session.receivePending("pending", 4, 7, 2)
        assertEquals(ActionStage.IDLE, r.session.dialog.stage); assertNull(r.gateway.readback)
        r.session.begin(7, 4); r.session.receivePending("pending", 4, 7, 3)
        assertNull(r.gateway.readback); assertEquals(0, r.gateway.approvals)
    }
    @Test fun lateReadbackFromOldGenerationCannotChangeTheNewSession() {
        val r = Rig(); r.session.begin(7, 3); r.session.receivePending("pending", 4, 7, 3)
        val late = r.gateway.readback!!; r.session.begin(7, 4)
        late(Result.success(r.proposal("pending").copy(version = 4)))
        assertEquals(ActionStage.IDLE, r.session.dialog.stage); assertNull(r.session.proposal)
        assertEquals(0, r.gateway.approvals); assertEquals(1, r.gateway.cancels)
    }
    @Test fun aSecondCalendarPendingCanBeReadAfterPriorProposalReadbackFailed() {
        val r = Rig(); r.session.begin(7, 3); r.session.receivePending("first", 1, 7, 3)
        r.gateway.readback!!(Result.failure(IllegalStateException("offline")))
        assertEquals(ActionStage.RESULT, r.session.dialog.stage); assertEquals(1, r.gateway.cancels)
        r.session.receivePending("second", 2, 7, 3)
        assertEquals("second", r.session.dialog.actionId)
        r.gateway.readback!!(Result.success(r.proposal("second").copy(version = 2)))
        assertEquals(ActionStage.READBACK, r.session.dialog.stage)
    }
    @Test fun expiredProposalDoesNotLeaveAProcessingSessionOrEnableApproval() {
        val r=Rig();r.session.begin(1,1);r.session.receive(r.proposal().copy(expiresAt=r.now))
        assertEquals("expired",r.session.outcome);assertFalse(r.session.busy)
        r.session.approveButton();assertEquals(0,r.gateway.approvals)
    }
    @Test fun modeSwitchInvalidatesReadbackCallbacksBeforeTheyCanOpenApproval() {
        val r=Rig();r.begin();val late=r.output.done!!
        r.session.suspend();late();r.session.approveButton()
        assertEquals(0,r.gateway.approvals);assertFalse(r.session.readbackFinished)
    }
    @Test fun missingMicrophoneDoesNotLeaveDictationStuckOrCreateAProposal() {
        val r=Rig();r.allowed=false
        val line=listOf(Sentence("offer",WavAudio("offer")))
        r.gateway.mail=MailCandidate("mail",false,true,true,line,line,line,ActionDisplay(sender="sender"))
        r.session.begin(1,1);r.session.afterBriefing(900);r.output.done!!()
        r.session.acceptOffer(false);r.output.done!!()
        assertFalse(r.session.busy);assertEquals(0,r.input.starts);assertEquals(0,r.gateway.proposals)
    }
    @Test fun decliningAnOfferDoesNotProposeOrApproveAndNeverReoffersThatTrip() {
        val r=Rig();val line=listOf(Sentence("offer",WavAudio("offer")))
        r.gateway.mail=MailCandidate("mail",false,true,true,line,line,line,ActionDisplay(sender="sender"))
        r.session.begin(1,1);r.session.afterBriefing(900);r.session.decline();r.session.afterBriefing(900)
        assertEquals("declined",r.session.outcome);assertEquals(1,r.gateway.scans)
        assertEquals(0,r.gateway.proposals);assertEquals(0,r.gateway.approvals)
    }
    @Test fun rejectedDictationNeverEnablesAnApproval() {
        val r=Rig();r.session.begin(1,1);r.session.receive(r.proposal(status="rejected"))
        r.output.done!!();r.session.approveButton()
        assertEquals("rejected",r.session.outcome);assertEquals(0,r.gateway.approvals)
    }
    @Test fun calendarClarificationRequiresANewCompleteReadbackBeforeApproval() {
        val r=Rig();r.session.begin(1,1);r.session.receive(r.proposal(status="needs_clarification"))
        r.output.done!!();r.session.clarify(WavAudio("answer"))
        r.gateway.clarified!!(Result.success(r.proposal().copy(version=2)))
        r.session.approveButton();assertEquals(0,r.gateway.approvals)
        r.output.done!!();r.session.approveButton();assertEquals(1,r.gateway.approvals)
        assertEquals(1,r.gateway.clarifications)
    }
    @Test fun aSecondCalendarAmbiguityIsCancelledInsteadOfAskedAgain() {
        val r=Rig();r.session.begin(1,1);r.session.receive(r.proposal(status="needs_clarification"))
        r.output.done!!();r.session.clarify(WavAudio("answer"))
        r.gateway.clarified!!(Result.success(r.proposal(status="needs_clarification").copy(version=2)))
        assertEquals(1,r.gateway.clarifications);assertEquals(1,r.gateway.cancels)
        assertEquals("cancelled",r.session.outcome);assertEquals(0,r.gateway.approvals)
    }
    @Test fun dictationBytesAreZeroedAndLateProposalFromOldGenerationIsDropped() {
        val r=Rig();val line=listOf(Sentence("offer",WavAudio("offer")))
        r.gateway.mail=MailCandidate("mail",false,true,true,line,line,line,ActionDisplay(sender="sender"))
        r.session.begin(1,1);r.session.afterBriefing(900);r.session.acceptOffer(false);r.output.done!!()
        val bytes=AudioClip.wav(ShortArray(1600){1000});r.input.result!!(Result.success(AudioClip(bytes,r.now,true)))
        assertTrue(bytes.all { it==0.toByte() });val late=r.gateway.proposed!!
        r.session.begin(1,2);late(Result.success(r.proposal()))
        assertNull(r.session.dialog.actionId);assertEquals(ActionStage.IDLE,r.session.dialog.stage)
        assertEquals(0,r.gateway.approvals)
    }
    @Test fun demoAlwaysKeepsTenFullSecondsAfterTheHoldClipActuallyFinishes() {
        val r=Rig(demo=true);r.ready();r.session.approveButton()
        r.gateway.approval!!(Result.success(ActionApproval("one","holding",r.now+12000,r.now,
            listOf(Sentence("hold",WavAudio("hold"))),null,null)))
        r.advance(4000);r.output.done!!()
        r.advance(9999)
        assertEquals(ActionStage.HOLDING,r.session.dialog.stage)
        assertEquals(0,r.gateway.statuses)
        r.advance(1)
        assertEquals(1,r.gateway.statuses)
    }
}
