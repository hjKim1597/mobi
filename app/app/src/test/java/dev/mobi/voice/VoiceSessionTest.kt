package dev.mobi.voice

import dev.mobi.net.*
import dev.mobi.trip.Clock
import org.junit.Assert.*
import org.junit.Test

class VoiceSessionTest {
    private class Input : VoiceInput {
        var callback: ((Result<AudioClip>) -> Unit)? = null
        var active = false
        override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit, result: (Result<AudioClip>) -> Unit): CancelHandle {
            check(allowed()); active = true; callback = result
            return CancelHandle { active = false }
        }
        override fun close() { active = false }
    }
    private class Output : VoiceOutput {
        var startImmediately = true
        var prepareImmediately = true
        var inputReady: (() -> Unit)? = null
        var startCallback: (() -> Unit)? = null
        override fun prepareInput(ready: () -> Unit, failed: () -> Unit) {
            inputReady = ready
            if (prepareImmediately) ready()
        }
        var starts = 0; var paused = false; var completed: (() -> Unit)? = null; var failed: (() -> Unit)? = null
        val played = mutableListOf<WavAudio>()
        override fun play(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit) {
            starts++; played += audio; paused = false; completed = finished; startCallback = started; this.failed = failed; if (startImmediately) started()
        }
        override fun pause() { paused = true }
        override fun resume() { paused = false }
        override fun stop() { completed = null }
        override fun close() = stop()
    }
    private class Rig {
        var now = 0L; val clock = Clock { now }; val input = Input(); val output = Output()
        var briefCallback: ((Result<BriefingResponse>) -> Unit)? = null
        var turnCallback: ((Result<TurnResponse>) -> Unit)? = null
        var confirmCallback: ((Result<ConfirmResponse>) -> Unit)? = null
        var confirmHandleCancellations = 0
        var turnHandleCancellations = 0
        var autoEffect = true; var effectDone: (() -> Unit)? = null
        var localFailuresEnabled = false
        val confirmFailureAudio = WavAudio("confirm-failure")
        val questionFailureAudio = WavAudio("question-failure")
        var hasAudioFocus = true
        val actionProposals = mutableListOf<Pair<Operation,ActionProposal>>()
        val pendingProposals = mutableListOf<Pair<Operation,ActionProposalPending>>()
        val events = mutableListOf<String>(); val intents = mutableListOf<Intent>()
        val timers = mutableListOf<Pair<Long, () -> Unit>>()
        val session = VoiceSession(clock, input, output,
            { _, _, cb -> briefCallback = cb; CancelHandle {} },
            { _, _, cb -> confirmCallback = cb; CancelHandle { confirmHandleCancellations++; events += "confirm-request-cancelled" } },
            { _, _, cb -> turnCallback = cb; CancelHandle { turnHandleCancellations++; events += "turn-request-cancelled" } },
            { delay, fn -> timers += now + delay to fn; CancelHandle { timers.removeAll { it.second === fn } } },
            { it() }, { true }, { hasAudioFocus }, { done -> effectDone = done; if (autoEffect) done() }, { events += it }, { intents += it }, {},
            localFailureAudio = { mode -> if (!localFailuresEnabled) null else if (mode == CaptureMode.CONFIRM) confirmFailureAudio else questionFailureAudio },
            actionProposal = { operation, proposal -> actionProposals += operation to proposal },
            actionProposalPending = { operation, pending -> pendingProposals += operation to pending })
        val audio = WavAudio("fixture")
        val offlineAudio = WavAudio("offline-fixture")
        val bundle = KnockBundle("knock-v1", "2026-10-24", "Asia/Seoul", 3,
            KnockAudio("online", audio, "0".repeat(64)), KnockAudio("offline", offlineAudio, "0".repeat(64)))
        fun op(serial: Long = 1) = Operation(1, 1, serial, RequestDeadline(clock, now + 6000))
        fun expire() { now += 6000; timers.toList().forEach { if (it.first <= now) it.second() } }
        fun advanceTo(target: Long) { now = target; timers.toList().forEach { if (it.first <= now) it.second() } }
        fun capture(mode: CaptureMode, serial: Long = 1) {
            session.listen(op(serial), mode)
            input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600) { 1000 }), 0, true)))
        }
    }
    @Test fun offlineKnockSelectsOnlyInformationAssetWithoutNetworkOrMicrophone() {
        val r = Rig(); r.localFailuresEnabled = true
        r.session.startKnock(r.op(), r.bundle, 180, false)
        assertEquals(listOf(r.offlineAudio), r.output.played)
        assertEquals(listOf("knock-started"), r.events)
        assertNull(r.briefCallback); assertNull(r.confirmCallback); assertNull(r.turnCallback)
        assertNull(r.input.callback); assertFalse(r.input.active)
        r.output.completed!!()
        assertTrue("complete" in r.events); assertNull(r.session.operation)
        assertNull(r.briefCallback); assertNull(r.confirmCallback); assertNull(r.turnCallback)
        assertNull(r.input.callback); assertTrue(r.intents.isEmpty())
        assertEquals(listOf(r.offlineAudio), r.output.played)
    }
    @Test fun missingOfflineCacheIsSilentEvenWithLocalFailureAudioEnabled() {
        val r = Rig(); r.localFailuresEnabled = true
        r.session.startKnock(r.op(), null, null, false)
        assertTrue(r.output.played.isEmpty()); assertEquals(0, r.output.starts)
        assertEquals(listOf("deferred"), r.events); assertNull(r.session.operation)
        assertNull(r.briefCallback); assertNull(r.confirmCallback); assertNull(r.turnCallback)
        assertNull(r.input.callback); assertFalse(r.input.active); assertTrue(r.intents.isEmpty())
    }
    @Test fun failedOfflinePlaybackDefersWithoutSpeakingErrorsOrStartingRequests() {
        val r = Rig(); r.localFailuresEnabled = true
        r.session.startKnock(r.op(), r.bundle, null, false)
        r.output.failed!!()
        assertEquals(listOf(r.offlineAudio), r.output.played)
        assertEquals("deferred", r.events.last()); assertNull(r.session.operation)
        assertFalse(r.events.any { it.endsWith("failure-started") })
        assertNull(r.briefCallback); assertNull(r.confirmCallback); assertNull(r.turnCallback)
        assertNull(r.input.callback); assertTrue(r.intents.isEmpty())
    }
    @Test fun emptyScheduleOfflineKnockStillNeverAsksForConfirmation() {
        val r = Rig()
        r.session.startKnock(r.op(), r.bundle.copy(eventCount = 0), null, false)
        assertEquals(listOf(r.offlineAudio), r.output.played)
        r.output.completed!!()
        assertTrue("complete" in r.events); assertNull(r.input.callback)
        assertNull(r.briefCallback); assertNull(r.confirmCallback); assertNull(r.turnCallback)
    }
    @Test fun offlineKnockPreservesNavigationAndFocusSafetyWithoutFallbackSpeech() {
        val r = Rig(); r.localFailuresEnabled = true; r.hasAudioFocus = false
        r.session.startKnock(r.op(), r.bundle, null, false)
        assertTrue(r.output.played.isEmpty()); assertTrue("deferred" in r.events)
        val nav = Rig(); nav.localFailuresEnabled = true; nav.session.onNavigation(true)
        nav.session.startKnock(nav.op(), nav.bundle, null, false)
        assertTrue(nav.output.played.isEmpty())
        nav.expire(); nav.session.onNavigation(false)
        assertTrue(nav.output.played.isEmpty()); assertNull(nav.input.callback)
    }
    @Test fun prefetchBeginsAtKnockStartAndWaitsForAcceptance() {
        val r = Rig(); r.session.startKnock(r.op(), r.bundle, 180, true)
        assertNotNull(r.briefCallback); assertEquals(1, r.output.starts)
        r.briefCallback!!(Result.success(BriefingResponse("id", "1", "short", "brief", r.audio)))
        assertEquals(1, r.output.starts); r.session.accept(r.session.operation!!)
        assertEquals(2, r.output.starts); assertFalse(r.input.active)
    }
    @Test fun declineNewTurnTimeoutAndPrepareCannotReviveOldPlayback() {
        val r = Rig(); r.session.startKnock(r.op(), r.bundle, null, true)
        val old = r.briefCallback!!; r.session.cancel()
        old(Result.success(BriefingResponse("id", "1", "summary", "late", r.audio)))
        assertEquals(1, r.output.starts)
        r.session.listen(r.op(2), CaptureMode.QUESTION)
        r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600){1000}), 0, true)))
        val late = r.turnCallback!!; r.advanceTo(8000)
        late(Result.success(TurnResponse("id", "question", listOf(Sentence("late", r.audio)))))
        assertEquals(1, r.output.starts); assertTrue("deferred" in r.events)
    }
    @Test fun navigationBlocksStartsAndRecordingNeverOverlapsOutput() {
        val r = Rig(); r.session.onNavigation(true)
        r.session.startKnock(r.op(), r.bundle, null, true); assertEquals(0, r.output.starts)
        r.session.onNavigation(false); assertEquals(1, r.output.starts)
        r.output.completed!!(); assertTrue(r.input.active)
        r.session.onNavigation(true); assertFalse(r.input.active)
        r.expire(); r.session.onNavigation(false); assertEquals(1, r.output.starts)
    }
    @Test fun advisoryCannotUpgradeAmbiguousTranscriptOrAuthorizeWrites() {
        for (text in listOf("응", "보네", "아니 보내줘", "보내지 마", "")) {
            val r=Rig();r.session.listen(r.op(),CaptureMode.CONFIRM)
            r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600){1000}),0,true)))
            r.confirmCallback!!(Result.success(ConfirmResponse(text, ConfirmMatch("보내","SEND","exact"))))
            assertEquals(listOf(Intent.classify(text)),r.intents)
            assertEquals(listOf("confirm-decision-${Intent.classify(text).name.lowercase()}"), r.events.filter { it.startsWith("confirm-decision-") })
            assertFalse(r.intents.any { it == Intent.SEND || it == Intent.CHANGE })
        }
    }
    @Test fun briefingResponseDuringServerConfirmationRemainsAvailableForAccept() {
        val r=Rig();r.session.startKnock(r.op(),r.bundle,180,true)
        r.output.completed!!()
        r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600){1000}),0,true)))
        r.briefCallback!!(Result.success(BriefingResponse("id","1","short","ready",r.audio)))
        r.confirmCallback!!(Result.success(ConfirmResponse("응",ConfirmMatch("응","LISTEN","exact"))))
        r.session.accept(r.session.operation!!)
        assertEquals(2,r.output.starts)
    }
    @Test fun tapAcceptanceIgnoresAlreadyPendingVoiceConfirmation() {
        val r=Rig();r.session.startKnock(r.op(),r.bundle,180,true);r.output.completed!!()
        r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600){1000}),0,true)))
        r.briefCallback!!(Result.success(BriefingResponse("id","1","short","ready",r.audio)))
        r.session.accept(r.session.operation!!)
        r.confirmCallback!!(Result.success(ConfirmResponse("됐어",ConfirmMatch("됐어","NOT_NOW","exact"))))
        assertTrue(r.intents.isEmpty());assertEquals(2,r.output.starts)
    }
    @Test fun completedPrefetchDoesNotShortenTheSeparateParkedResponseWindow() {
        val r=Rig();r.session.startKnock(r.op(),r.bundle,180,true)
        r.briefCallback!!(Result.success(BriefingResponse("id","1","short","ready",r.audio)))
        r.now=6500
        r.session.accept(r.session.operation!!)
        assertEquals(2,r.output.starts)
    }
    @Test fun acceptedReadyAudioStillHasABoundedPrepareAndStartDeadline() {
        val r=Rig();r.session.startKnock(r.op(),r.bundle,180,true)
        r.briefCallback!!(Result.success(BriefingResponse("id","1","short","ready",r.audio)))
        r.output.startImmediately=false;r.session.accept(r.session.operation!!)
        r.now=1000;r.timers.toList().forEach{if(it.first<=r.now)it.second()}
        assertTrue("deferred" in r.events);assertNull(r.session.operation)
    }
    @Test fun fastServerResultCannotCancelTheLocalAcknowledgementBeforeItPlays() {
        for(mode in listOf(CaptureMode.CONFIRM,CaptureMode.QUESTION)) {
            val r=Rig();r.autoEffect=false;r.session.listen(r.op(),mode)
            r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600){1000}),0,true)))
            if(mode==CaptureMode.QUESTION)r.turnCallback!!(Result.success(TurnResponse("id","question",listOf(Sentence("answer",r.audio)))))
            else r.confirmCallback!!(Result.success(ConfirmResponse("응",ConfirmMatch("응","LISTEN","exact"))))
            assertEquals(0,r.output.starts);assertTrue(r.intents.isEmpty())
            r.effectDone!!()
            if(mode==CaptureMode.QUESTION)assertEquals(1,r.output.starts) else assertEquals(listOf(Intent.ACCEPT),r.intents)
        }
    }
    @Test fun navigationPauseAfterPlaybackStartStillExpiresTheOriginalBudget() {
        val r=Rig();r.session.startKnock(r.op(),r.bundle,180,true)
        r.briefCallback!!(Result.success(BriefingResponse("id","1","short","ready",r.audio)))
        r.session.accept(r.session.operation!!);r.session.onNavigation(true);r.expire()
        assertNull(r.session.operation);assertTrue("deferred" in r.events)
    }
    @Test fun finalDeclineOrCancelInAQuestionTurnSuppressesItsServerAudio() {
        for(text in listOf("됐어","그만","취소","보내지 마")) {
            val r=Rig();r.session.listen(r.op(),CaptureMode.QUESTION)
            r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600){1000}),0,true)))
            r.turnCallback!!(Result.success(TurnResponse("id",text,listOf(Sentence("must not play",r.audio)))))
            assertEquals(listOf(Intent.classify(text)),r.intents);assertEquals(0,r.output.starts)
        }
    }
    @Test fun confirmErrorPlaysItsLocalFailureOnceWithoutClassifyingOrAuthorizing() {
        val r = Rig(); r.localFailuresEnabled = true; r.capture(CaptureMode.CONFIRM)
        val callback = r.confirmCallback!!
        callback(Result.failure(ApiFailure(0, "UNAVAILABLE")))
        callback(Result.failure(ApiFailure(0, "TIMEOUT")))
        assertEquals(listOf(r.confirmFailureAudio), r.output.played)
        assertEquals(1, r.confirmHandleCancellations)
        assertTrue(r.events.indexOf("confirm-request-cancelled") < r.events.indexOf("confirm-failure-started"))
        assertTrue(r.intents.isEmpty()); assertFalse(r.events.any { it.startsWith("confirm-decision-") })
        assertTrue("confirm-failure-started" in r.events)
    }
    @Test fun failureAssetPlaybackErrorDoesNotLoopOrInvokeTts() {
        val r = Rig(); r.localFailuresEnabled = true; r.capture(CaptureMode.CONFIRM)
        r.confirmCallback!!(Result.failure(ApiFailure(503, "UNAVAILABLE")))
        r.output.failed!!()
        assertEquals(listOf(r.confirmFailureAudio), r.output.played)
        assertEquals(1, r.output.starts)
        assertTrue("deferred" in r.events)
    }
    @Test fun localFailureSentenceFinishesDeferredWhileServerDegradedSentenceCompletes() {
        val local = Rig(); local.localFailuresEnabled = true; local.capture(CaptureMode.CONFIRM)
        local.confirmCallback!!(Result.failure(ApiFailure(503, "UNAVAILABLE")))
        local.output.completed!!()
        assertTrue("deferred" in local.events)
        assertFalse("complete" in local.events)

        val server = Rig(); server.localFailuresEnabled = true; server.capture(CaptureMode.QUESTION)
        server.turnCallback!!(Result.success(TurnResponse("degraded", "오늘 일정 뭐야", listOf(Sentence("응답이 늦어 답을 드리지 못했어요.", server.audio)))))
        server.output.completed!!()
        assertTrue("complete" in server.events)
        assertFalse("deferred" in server.events)
    }
    @Test fun questionReplyPreparationKeepsOriginalEightSecondDeadlineAndRejectsLateStart() {
        val r = Rig(); r.output.startImmediately = false; r.capture(CaptureMode.QUESTION)
        r.turnCallback!!(Result.success(TurnResponse("id", "오늘 일정 뭐야", listOf(Sentence("오늘 3개, 다음은 14:00예요.", r.audio)))))
        assertNotNull(r.session.operation)
        r.advanceTo(8000)
        assertNull(r.session.operation)
        r.output.startCallback!!()
        assertTrue(r.output.played.size == 1)
        assertFalse("turn-started" in r.events)
        assertTrue("deferred" in r.events)
    }
    @Test fun questionResultAfterSixSecondsIsAcceptedAgainstLastVoicedEightSecondDeadline() {
        val r = Rig()
        r.session.listen(r.op(), CaptureMode.QUESTION)
        r.now = 500 // Recorder callback arrives after speech ended at 100ms.
        r.input.callback!!(Result.success(AudioClip(AudioClip.wav(ShortArray(1600) { 1000 }), 100, true)))

        assertEquals(8100L, r.session.operation!!.deadline.expiresAtMillis)
        r.now = 7300
        r.turnCallback!!(Result.success(TurnResponse("id", "오늘 일정 뭐야", listOf(Sentence("오늘 3개예요.", r.audio)))))

        assertEquals(listOf(r.audio), r.output.played)
        assertTrue("turn-started" in r.events)
        assertFalse("deferred" in r.events)
        assertEquals(8100L, r.session.operation!!.deadline.expiresAtMillis)
    }
    @Test fun localFailurePreparationKeepsOriginalDeadlineAndRejectsLateStart() {
        val r = Rig(); r.localFailuresEnabled = true; r.output.startImmediately = false; r.capture(CaptureMode.CONFIRM)
        r.confirmCallback!!(Result.failure(ApiFailure(503, "UNAVAILABLE")))
        assertEquals(listOf(r.confirmFailureAudio), r.output.played)
        assertNotNull(r.session.operation)
        r.advanceTo(6000)
        assertNull(r.session.operation)
        r.output.startCallback!!()
        assertFalse("confirm-failure-started" in r.events)
        assertEquals(listOf(r.confirmFailureAudio), r.output.played)
        assertTrue("deferred" in r.events)
    }
    @Test fun questionTimeoutKeepsTheEightSecondDeadlineAnd250msPresentationMargin() {
        val r = Rig(); r.localFailuresEnabled = true; r.capture(CaptureMode.QUESTION)
        assertEquals(8000L, r.session.operation!!.deadline.expiresAtMillis)
        r.advanceTo(7750)
        assertEquals(listOf(r.questionFailureAudio), r.output.played)
        assertEquals(1, r.turnHandleCancellations)
        assertTrue(r.events.indexOf("turn-request-cancelled") < r.events.indexOf("turn-failure-started"))
        assertTrue(r.events.any { it == "turn-failure-started" })
        val late = r.turnCallback!!
        late(Result.success(TurnResponse("late", "오늘 일정 뭐야", listOf(Sentence("late success", r.audio)))))
        assertEquals(listOf(r.questionFailureAudio), r.output.played)
        assertTrue(r.now < 8000)
    }
    @Test fun confirmTimeoutUsesOnlyTheConfirmFailureAsset() {
        val r = Rig(); r.localFailuresEnabled = true; r.capture(CaptureMode.CONFIRM)
        assertEquals(6000L, r.session.operation!!.deadline.expiresAtMillis)
        r.advanceTo(5750)
        assertEquals(listOf(r.confirmFailureAudio), r.output.played)
        assertTrue("confirm-failure-started" in r.events)
        assertFalse("turn-failure-started" in r.events)
    }
    @Test fun debugBaselineKeepsTheEightSecondQuestionTimeoutWithoutLocalFailureAudio() {
        val r = Rig(); r.capture(CaptureMode.QUESTION)
        r.advanceTo(7750)
        assertTrue(r.output.played.isEmpty()); assertFalse("deferred" in r.events)
        r.advanceTo(8000)
        assertTrue("deferred" in r.events); assertTrue(r.output.played.isEmpty())
    }
    @Test fun returnedQuestionDegradedSentencePlaysOnceWithoutAppendingLocalFallback() {
        val r = Rig(); r.localFailuresEnabled = true; r.capture(CaptureMode.QUESTION)
        r.turnCallback!!(Result.success(TurnResponse("degraded", "오늘 일정 뭐야", listOf(Sentence("응답이 늦어 답을 드리지 못했어요.", r.audio)))))
        assertEquals(listOf(r.audio), r.output.played)
        assertTrue("turn-started" in r.events); assertFalse("turn-failure-started" in r.events)
    }
    @Test fun navigationAndAudioFocusSuppressFailurePlayback() {
        val navigation = Rig(); navigation.localFailuresEnabled = true; navigation.capture(CaptureMode.CONFIRM)
        navigation.session.onNavigation(true)
        navigation.confirmCallback!!(Result.failure(ApiFailure(0, "TIMEOUT")))
        assertTrue(navigation.output.played.isEmpty())
        navigation.session.onNavigation(false)
        assertTrue("failure audio is discarded after navigation ends", navigation.output.played.isEmpty())

        val noFocus = Rig(); noFocus.localFailuresEnabled = true; noFocus.capture(CaptureMode.QUESTION); noFocus.hasAudioFocus = false
        noFocus.turnCallback!!(Result.failure(ApiFailure(0, "UNAVAILABLE")))
        assertTrue(noFocus.output.played.isEmpty())
        assertTrue("deferred" in noFocus.events)
    }
    @Test fun cancelledOrReplacedSessionCannotPlayAnOldFailureCue() {
        val cancelled = Rig(); cancelled.localFailuresEnabled = true; cancelled.capture(CaptureMode.CONFIRM)
        val oldConfirm = cancelled.confirmCallback!!; cancelled.session.cancel()
        oldConfirm(Result.failure(ApiFailure(0, "TIMEOUT")))
        assertTrue(cancelled.output.played.isEmpty())

        val replaced = Rig(); replaced.localFailuresEnabled = true; replaced.capture(CaptureMode.QUESTION)
        val oldTurn = replaced.turnCallback!!
        replaced.session.listen(Operation(2, 2, 2, RequestDeadline(replaced.clock, replaced.now + 6000)), CaptureMode.QUESTION)
        oldTurn(Result.failure(ApiFailure(0, "TIMEOUT")))
        assertTrue(replaced.output.played.isEmpty())
    }
    @Test fun tapAcceptWhileCuePreparesCannotStartLateRecording() {
        val r=Rig();r.output.prepareImmediately=false
        r.session.startKnock(r.op(),r.bundle,180,true)
        r.briefCallback!!(Result.success(BriefingResponse("id","1","short","ready",r.audio)))
        r.output.completed!!()
        r.session.accept(r.session.operation!!)
        r.output.inputReady!!()
        assertFalse(r.input.active);assertEquals(2,r.output.starts)
    }
    @Test fun turnProposalTransfersOriginalOperationAndDoesNotSpeakOrdinaryAnswer() {
        val r=Rig(); r.capture(CaptureMode.QUESTION)
        val proposal=ActionProposal("action",1,"awaiting_approval","hash",emptyList(),ActionDisplay(title="회의"),90000,null)
        r.turnCallback!!(Result.success(TurnResponse("turn","일정 추가해",emptyList(),proposal)))
        assertEquals(1,r.actionProposals.size)
        assertEquals(1L,r.actionProposals.single().first.tripId)
        assertEquals(1L,r.actionProposals.single().first.generation)
        assertEquals(proposal,r.actionProposals.single().second)
        assertNull(r.session.operation); assertEquals(0,r.output.starts)
    }
    @Test fun staleTurnProposalCannotStartAnActionAfterVoiceSessionWasCancelled() {
        val r=Rig(); r.capture(CaptureMode.QUESTION); val late=r.turnCallback!!
        r.session.cancel()
        val proposal=ActionProposal("action",1,"awaiting_approval","hash",emptyList(),ActionDisplay(title="회의"),90000,null)
        late(Result.success(TurnResponse("turn","일정 추가해",emptyList(),proposal)))
        assertTrue(r.actionProposals.isEmpty())
    }
    @Test fun pendingTurnPlaysShortSentenceBeforeHandingOffPendingReadback() {
        val r = Rig(); r.capture(CaptureMode.QUESTION)
        val pending = ActionProposalPending("action", 2)
        val short = Sentence("일정 내용을 확인할게요.", r.audio)
        r.turnCallback!!(Result.success(TurnResponse("turn", "일정 추가해", listOf(short), actionProposalPending = pending)))
        assertTrue(r.pendingProposals.isEmpty()); assertEquals(listOf(r.audio), r.output.played)
        r.output.completed!!()
        assertEquals(1, r.pendingProposals.size); assertEquals(pending, r.pendingProposals.single().second)
        assertEquals(1L, r.pendingProposals.single().first.tripId); assertEquals(1L, r.pendingProposals.single().first.generation)
        assertTrue(r.actionProposals.isEmpty())
    }
    @Test fun stalePendingTurnCannotHandOffAfterVoiceSessionWasCancelled() {
        val r = Rig(); r.capture(CaptureMode.QUESTION); val late = r.turnCallback!!; r.session.cancel()
        late(Result.success(TurnResponse("turn", "일정 추가해", listOf(Sentence("확인할게요", r.audio)), actionProposalPending = ActionProposalPending("action", 1))))
        assertTrue(r.pendingProposals.isEmpty())
    }
}
