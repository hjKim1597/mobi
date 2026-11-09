package dev.mobi.voice

import dev.mobi.net.*
import dev.mobi.trip.Clock
import java.util.Base64

/** Transient IO only. Trip/dialogue truth belongs to MobiService. All methods run on its state thread. */
class VoiceSession(
    private val clock: Clock,
    private val input: VoiceInput,
    private val output: VoiceOutput,
    private val briefing: (BriefingRequest, RequestDeadline, (Result<BriefingResponse>) -> Unit) -> CancelHandle,
    private val confirm: (WavAudio, RequestDeadline, (Result<ConfirmResponse>) -> Unit) -> CancelHandle,
    private val turn: (WavAudio, RequestDeadline, (Result<TurnResponse>) -> Unit) -> CancelHandle,
    private val schedule: (Long, () -> Unit) -> CancelHandle,
    private val post: (() -> Unit) -> Unit,
    private val permitted: () -> Boolean,
    private val focus: () -> Boolean,
    private val effect: (() -> Unit) -> Unit,
    private val event: (String) -> Unit,
    private val sentence: (Intent) -> Unit,
    private val phase: (String) -> Unit,
    private val localFailureAudio: (CaptureMode) -> WavAudio? = { null },
    private val actionProposal: (Operation, ActionProposal) -> Unit = { _, _ -> },
    private val actionProposalPending: (Operation, ActionProposalPending) -> Unit = { _, _ -> },
) : AutoCloseable {
    @Volatile var operation: Operation? = null; private set
    private val requests = mutableListOf<CancelHandle>()
    @Volatile private var capture: CancelHandle? = null
    private var timer: CancelHandle? = null
    @Volatile private var navigation = false
    private var waiting: (() -> Unit)? = null
    private var ready: BriefingResponse? = null
    private var accepted = false
    private var capturing = false
    private var playbackStarted = false
    private var awaitingResponse = false
    private var nextFailureSerial = Long.MIN_VALUE
    private fun current(op: Operation) = operation?.let { it.tripId == op.tripId && it.generation == op.generation && it.serial == op.serial } == true
    private fun valid(op: Operation) = current(op) && !op.deadline.expired
    private fun arm(op: Operation) {
        timer?.cancel()
        timer = schedule(op.deadline.remainingMillis()) { if (current(op)) defer() }
    }
    private fun armResponse(op: Operation, presentationFallbackAvailable: Boolean, failed: (Boolean) -> Unit) {
        awaitingResponse = true
        timer?.cancel()
        val margin = if (presentationFallbackAvailable) FAILURE_PRESENTATION_MARGIN_MS else 0L
        timer = schedule((op.deadline.remainingMillis() - margin).coerceAtLeast(0)) {
            if (awaitingResponse && current(op)) {
                if (op.deadline.expired) defer() else failed(true)
            }
        }
    }
    private fun defer() { cancel(); event("deferred") }
    fun startKnock(op: Operation, bundle: KnockBundle?, remainingSeconds: Int?, online: Boolean) {
        cancel(); operation = op
        if (bundle == null) { defer(); return }
        val interactive = online && bundle.eventCount > 0
        val asset = if (online) bundle.online else bundle.offline
        play(op, asset.audio, {
            event("knock-started")
            if (interactive) {
                arm(op)
                requests += briefing(BriefingRequest(op.tripId.toString(), remainingSeconds), op.deadline) { result -> post {
                    if (!valid(op)) return@post
                    result.fold({ ready = it; if (accepted) playBriefing(operation ?: op) else timer?.cancel() }, { defer() })
                } }
            }
        }, {
            if (interactive) {
                event("knock-finished")
                if (!accepted && permitted()) listenConfirmation(op)
            } else { cancel(); event("complete") }
        })
    }
    fun accept(op: Operation) {
        if (!current(op)) return
        if (ready == null && op.deadline.expired) { defer(); return }
        capture?.cancel(); capture = null; capturing = false; output.stop()
        awaitingResponse = false
        timer?.cancel()
        accepted = true
        if (ready != null) {
            // Prefetch IO is complete; acceptance has its own one-second presentation target.
            val presentation = op.copy(deadline = RequestDeadline(clock, clock.elapsedRealtimeMillis() + 1000))
            operation = presentation
            arm(presentation)
            playBriefing(presentation)
        } else { phase("THINKING"); arm(op) }
    }
    private fun playBriefing(op: Operation) {
        val value = ready ?: return
        ready = null
        play(op, value.audio, { timer?.cancel(); event("briefing-started") }, { cancel(); event("complete") })
    }
    private fun play(op: Operation, audio: WavAudio, started: () -> Unit, finished: () -> Unit) {
        if (!valid(op)) { if (current(op)) defer(); return }
        if (navigation) { waiting = { play(op, audio, started, finished) }; arm(op); return }
        if (!focus()) { defer(); return }
        capture?.cancel(); capture = null; capturing = false
        phase("SPEAKING"); playbackStarted = false
        arm(op)
        output.play(audio, { post {
            if (!current(op)) { output.stop(); return@post }
            if (!valid(op) || navigation) { output.stop(); defer(); return@post }
            timer?.cancel(); timer = null
            playbackStarted = true; started()
        } }, { post {
            if (!current(op)) return@post
            phase("IDLE"); finished()
        } }, { post { if (current(op)) defer() } })
    }
    private fun listenConfirmation(op: Operation) {
        // Preserve a concurrently prefetched briefing while recording the response.
        capture(op, CaptureMode.CONFIRM)
    }
    fun listen(op: Operation, mode: CaptureMode) {
        cancel(); operation = op
        capture(op, mode)
    }
    private fun capture(op: Operation, mode: CaptureMode) {
        if (!current(op) || navigation || !permitted() || !focus()) { if (current(op)) defer(); return }
        output.stop(); capture?.cancel(); capturing = false; phase("THINKING")
        output.prepareInput({ post {
            if (!current(op) || mode == CaptureMode.CONFIRM && accepted) return@post
            if (!navigation && permitted()) captureReady(op, mode) else defer()
        } }, { post { if (current(op)) defer() } })
    }
    private fun captureReady(op: Operation, mode: CaptureMode) {
        capturing = true; phase("LISTENING")
        capture = input.start(mode, { current(op) && !navigation && permitted() }, { post {
            if (current(op)) { timer?.cancel(); event("voice-started") }
        } }, { result -> post {
            if (!current(op) || mode == CaptureMode.CONFIRM && accepted) { result.getOrNull()?.wav?.fill(0); return@post }
            capture = null; capturing = false
            result.fold({ clip ->
                if (!clip.voiced || !permitted() || navigation) { clip.wav.fill(0); defer(); return@fold }
                val requestBudgetMs = if (mode == CaptureMode.QUESTION) 8000L else 6000L
                val requestOp = op.copy(deadline = RequestDeadline(clock, clip.lastVoicedAtMillis + requestBudgetMs))
                operation = requestOp
                val audio = try {
                    WavAudio(Base64.getEncoder().encodeToString(clip.wav))
                } finally {
                    clip.wav.fill(0)
                }
                if (!valid(requestOp)) { defer(); return@fold }
                phase("THINKING")
                var acknowledged = false
                var pending: (() -> Unit)? = null
                fun afterAcknowledgement(action: () -> Unit) {
                    if (acknowledged) action() else pending = action
                }
                effect { post {
                    if (!current(requestOp)) return@post
                    acknowledged = true
                    pending?.invoke(); pending = null
                } }
                val localFailure = localFailureAudio(mode)
                var requestHandle: CancelHandle? = null
                fun releaseRequest(cancel: Boolean) {
                    val handle = requestHandle ?: return
                    requestHandle = null
                    requests.remove(handle)
                    if (cancel) handle.cancel()
                }
                fun trackRequest(handle: CancelHandle) {
                    requestHandle = handle
                    requests += handle
                }
                fun pendingResponse() = awaitingResponse && valid(requestOp)
                fun completeResponse(): Boolean {
                    if (!pendingResponse()) return false
                    awaitingResponse = false
                    timer?.cancel(); timer = null
                    releaseRequest(cancel = false)
                    return true
                }
                fun failResponse(status: String) {
                    if (!pendingResponse()) return
                    awaitingResponse = false
                    timer?.cancel(); timer = null
                    releaseRequest(cancel = true)
                    val route = if (mode == CaptureMode.CONFIRM) "confirm" else "turn"
                    event("$route-result-$status")
                    if (localFailure == null || navigation || !permitted()) { defer(); return }
                    val failureOp = requestOp.copy(serial = nextFailureSerial++)
                    operation = failureOp
                    play(failureOp, localFailure, { event("$route-failure-started") }, { defer() })
                }
                armResponse(requestOp, localFailure != null) { timeout -> failResponse(if (timeout) "timeout" else "error") }
                if (mode == CaptureMode.CONFIRM) {
                    trackRequest(confirm(audio, requestOp.deadline) { response -> post {
                        afterAcknowledgement {
                            if (pendingResponse() && !accepted) response.fold({ value ->
                                if (!completeResponse()) return@fold
                                event("confirm-result-success")
                                event("confirm-result")
                                    // Server matches are advisory; only the local exact dictionary decides.
                                    val intent = Intent.classify(value.transcript)
                                    event("confirm-decision-${intent.name.lowercase()}")
                                    operation = requestOp
                                    sentence(intent)
                                    if (intent != Intent.ACCEPT) {
                                        if (intent == Intent.SEND || intent == Intent.CHANGE) defer() else cancel()
                                    }
                            }, { failResponse(failureStatus(it)) })
                        }
                    } })
                } else {
                    trackRequest(turn(audio, requestOp.deadline) { response -> post {
                        afterAcknowledgement {
                            if (pendingResponse()) response.fold({ value ->
                                if (!completeResponse()) return@fold
                                val intent = Intent.classify(value.transcript)
                                if (value.actionProposal != null) {
                                    cancel(); event("action-proposal"); actionProposal(requestOp, value.actionProposal)
                                } else if (value.actionProposalPending != null) {
                                    val acknowledgement = value.sentences.singleOrNull()
                                    if (acknowledgement == null) { event("turn-result-error"); defer() }
                                    else play(requestOp, acknowledgement.audio, { timer?.cancel(); event("turn-started") }, {
                                        cancel(); event("action-proposal-pending"); actionProposalPending(requestOp, value.actionProposalPending)
                                    })
                                } else if (intent == Intent.DECLINE || intent == Intent.CANCEL) {
                                    event("turn-result-decision")
                                    sentence(intent); cancel()
                                } else {
                                    val reply = value.sentences.singleOrNull()
                                    if (reply == null) { event("turn-result-error"); defer() }
                                    else {
                                        event(if (reply.text == QUESTION_FAILURE_SENTENCE) "turn-result-degraded" else "turn-result-useful")
                                        play(requestOp, reply.audio, { timer?.cancel(); event("turn-started") }, { cancel(); event("complete") })
                                    }
                                }
                            }, { failResponse(failureStatus(it)) })
                        }
                    } })
                }
            }, { defer() })
        } })
    }
    fun pauseInputImmediately() { capture?.cancel() }

    fun onNavigation(active: Boolean) {
        navigation = active
        if (active) {
            output.pause()
            if (capturing) { capture?.cancel(); capture = null; capturing = false; defer() }
            else if (!awaitingResponse) operation?.let { arm(it) }
        } else {
            val op = operation ?: return
            if (!valid(op)) { defer(); return }
            val resume = waiting; waiting = null
            if (resume != null) resume() else if (focus()) output.resume()
        }
    }
    fun cancel() {
        awaitingResponse = false
        operation = null
        timer?.cancel(); timer = null; requests.toList().forEach { it.cancel() }; requests.clear(); capture?.cancel(); capture = null
        capturing = false; waiting = null; ready = null; accepted = false; playbackStarted = false
        output.stop(); phase("IDLE")
    }
    override fun close() { cancel(); input.close(); output.close() }

    private fun failureStatus(failure: Throwable): String = (failure as? ApiFailure)?.let {
        when {
            it.code == "TIMEOUT" -> "timeout"
            it.status in 400..499 -> "4xx"
            it.status in 500..599 -> "5xx"
            else -> "error"
        }
    } ?: "error"

    private companion object {
        const val FAILURE_PRESENTATION_MARGIN_MS = 250L
        const val QUESTION_FAILURE_SENTENCE = "응답이 늦어 답을 드리지 못했어요."
    }
}
