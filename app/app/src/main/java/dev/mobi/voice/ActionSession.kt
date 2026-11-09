package dev.mobi.voice

import dev.mobi.dialog.ActionDialog
import dev.mobi.dialog.ActionStage
import dev.mobi.net.*
import dev.mobi.trip.Clock
import java.util.Base64
import java.util.UUID

private const val QUIET_MAIL_NOTICE = "확인이 필요한 메일이 있어요. 정차 후 확인해 주세요."

enum class ActionCancelReason(val code: String) {
    PERMISSION("permission"), FOCUS("focus"), WATCHDOG_UNREADY("watchdog_unready"),
    WINDOW_SHORT("window_short"), VOICE_ONSET("voice_onset"), CAPTURE_FAILED("capture_failed"),
    CAPTURE_EXCEPTION("capture_exception"), USER("user"), OTHER("other"),
}

/** The live and local-demo gateways share the same approval and cancellation boundary. */
interface ActionGateway {
    fun capabilities(cb: (Result<Capabilities>) -> Unit): CancelHandle
    fun scan(tripId: String, quiet: Boolean = false, cb: (Result<MailScanResponse>) -> Unit): CancelHandle
    fun propose(request: ActionProposalRequest, cb: (Result<ActionProposal>) -> Unit): CancelHandle
    fun readback(id: String, cb: (Result<ActionProposal>) -> Unit): CancelHandle
    fun clarify(id: String, version: Int, audio: WavAudio, cb: (Result<ActionProposal>) -> Unit): CancelHandle
    fun approve(id: String, request: ActionApprovalRequest, cb: (Result<ActionApproval>) -> Unit): CancelHandle
    fun cancel(id: String, cb: (Result<ActionCancel>) -> Unit): CancelHandle
    fun status(id: String, cb: (Result<ActionStatus>) -> Unit): CancelHandle
}

/** Single state-thread owner. Every IO completion is bound to trip/generation/action/version/step. */
class ActionSession(
    private val clock: Clock,
    private val wallClock: () -> Long,
    private val gateway: ActionGateway,
    private val input: VoiceInput,
    private val output: VoiceOutput,
    private val schedule: (Long, () -> Unit) -> CancelHandle,
    private val post: (() -> Unit) -> Unit,
    private val permitted: () -> Boolean,
    private val focus: () -> Boolean,
    private val changed: () -> Unit,
    private val remember: (String?) -> Unit,
    private val wireTrip: (Long) -> String,
    private val localAudio: (String) -> WavAudio?,
    val demo: Boolean = false,
    private val offerConsumed: (Long) -> Unit = {},
    private val buttonPermitted: () -> Boolean = { true },
    private val quietMail: () -> Boolean = { false },
    private val diagnostic: (String) -> Unit = {},
) : AutoCloseable {
    val dialog = ActionDialog()
    var candidate: MailCandidate? = null; private set
    var proposal: ActionProposal? = null; private set
    var kind = "mail_reply"; private set
    var outcome: String? = null; private set
    var resultText = ""; private set
    var quietMailNotice = false; private set
    var voicePhase = "IDLE"; private set
    private var request: CancelHandle? = null
    private var capture: CancelHandle? = null
    private var timer: CancelHandle? = null
    private var playbackTimer: CancelHandle? = null
    private var holdWatchdog: CancelHandle? = null
    private var holdReady = false
    private var holdCaptureGeneration = 0L
    private var recoveryId: String? = null
    private var polls = 0
    private var clarificationUsed = false
    private var calendarOffer = false
    private var holdUntil = 0L
    /** Restore is conservative; live sessions set this only immediately before gateway.approve. */
    private var mayHaveExecuted = false
    private var kindKnown = true
    private var closed = false
    private var listening = false
    val busy get() = dialog.stage !in setOf(ActionStage.IDLE, ActionStage.RESULT, ActionStage.UNKNOWN)
    val readbackFinished get() = dialog.stage == ActionStage.AWAITING_APPROVAL
    private fun trace(line: String) {
        try { diagnostic(line) } catch (_: Exception) { /* Diagnostics never affect cancellation. */ }
    }
    private fun logCancellation(reason: ActionCancelReason) {
        val remaining = if (dialog.stage == ActionStage.HOLDING) holdUntil - clock.elapsedRealtimeMillis() else -1L
        // Capture before move()/stopIO() clears readiness and changes the stage.
        trace("ACTION_CANCEL reason=${reason.code} stage=${dialog.stage.name} remainingMs=$remaining holdReady=$holdReady")
    }
    private fun stopIO() {
        request?.cancel(); request = null; capture?.cancel(); capture = null
        timer?.cancel(); timer = null; playbackTimer?.cancel(); playbackTimer = null
        holdWatchdog?.cancel(); holdWatchdog = null
        holdReady = false; holdCaptureGeneration++
        listening = false; output.stop(); voicePhase = "IDLE"
    }
    private fun move(stage: ActionStage) { stopIO(); dialog.move(stage); changed() }
    fun begin(tripId: Long, generation: Long, alreadyOffered: Boolean = false) {
        if (dialog.tripId == tripId && dialog.generation == generation) return
        val old = dialog.actionId
        if (old != null && busy) { logCancellation(ActionCancelReason.OTHER); gateway.cancel(old) { } }
        stopIO(); dialog.begin(tripId, generation); if (alreadyOffered) dialog.markOffered()
        candidate = null; proposal = null; kind = "mail_reply"; outcome = null; resultText = ""; quietMailNotice = false; calendarOffer = false; clarificationUsed = false; mayHaveExecuted = false; kindKnown = true
        changed()
    }
    private fun <T> fetch(start: ((Result<T>) -> Unit) -> CancelHandle, done: (T) -> Unit, failed: () -> Unit = {
        if (mayHaveExecuted) uncertain() else notWritten()
    }) {
        val token = dialog.token()
        request = start { result -> post {
            if (closed || !dialog.current(token)) return@post
            request = null
            result.fold(done, { failed() })
        } }
    }
    fun afterBriefing(remainingSeconds: Int?) {
        if (closed || busy || remainingSeconds != null && remainingSeconds < 300 || !dialog.claimOffer()) return
        offerConsumed(dialog.tripId)
        move(ActionStage.PROCESSING)
        fetch<Capabilities>({ gateway.capabilities(it) }, { capabilities ->
            if (!capabilities.mailRead) { move(ActionStage.IDLE); return@fetch }
            val quietAtScan = quietMail()
            fetch<MailScanResponse>({ gateway.scan(wireTrip(dialog.tripId), quietAtScan, it) }, { scan ->
                val mail = scan.candidate
                if (mail == null) { move(ActionStage.IDLE); return@fetch }
                candidate = mail
                if (quietAtScan && !mail.sensitive) {
                    val validQuietNotice = !mail.canReply && !mail.canAddCalendar &&
                        mail.replyPromptSentences.orEmpty().isEmpty() && mail.calendarOfferSentences.orEmpty().isEmpty() &&
                        mail.sentences.size == 1 && mail.sentences.single().text == QUIET_MAIL_NOTICE
                    if (!validQuietNotice) { candidate = null; move(ActionStage.IDLE); return@fetch }
                    quietMailNotice = true
                    resultText = QUIET_MAIL_NOTICE
                    move(ActionStage.RESULT); speak(mail.sentences) { changed() }
                } else if (mail.sensitive || !mail.canReply && !mail.canAddCalendar) {
                    move(ActionStage.RESULT); speak(mail.sentences) { if (!quietMailNotice) candidate = null; changed() }
                } else offer(false)
            }, { move(ActionStage.IDLE) })
        }, { move(ActionStage.IDLE) })
    }
    private fun offer(calendar: Boolean) {
        // A completed reply and its calendar follow-up are separate actions.
        dialog.clearAction(); proposal = null; mayHaveExecuted = false
        calendarOffer = calendar
        kind = if (calendar || candidate?.canReply != true) "calendar_insert" else "mail_reply"
        kindKnown = true
        proposal = null; if (!calendar) { outcome = null; resultText = "" }; move(ActionStage.OFFER)
        speak(if (calendar) candidate?.calendarOfferSentences.orEmpty() else candidate?.sentences.orEmpty()) {
            if (!demo) listen(CaptureMode.CONFIRM) { audio ->
                // Offer acceptance uses the existing frozen accept/decline dictionary.
                val token = dialog.token()
                val confirmation = offerConfirm
                if (confirmation == null) { decline(); return@listen }
                request = confirmation(audio) { result -> post {
                    if (!dialog.current(token) || dialog.stage != ActionStage.OFFER) return@post
                    if (result.getOrNull()?.let { Intent.classify(it.transcript) } == Intent.ACCEPT) acceptOffer() else decline()
                } }
            }
        }
    }
    /** Kept separate from final approval: only the server judges action approval audio. */
    var offerConfirm: ((WavAudio, (Result<ConfirmResponse>) -> Unit) -> CancelHandle)? = null
    fun acceptOffer(calendar: Boolean = calendarOffer || kind == "calendar_insert") {
        if (dialog.stage != ActionStage.OFFER) return
        val mail = candidate ?: return
        if (mail.sensitive || calendar && !mail.canAddCalendar || !calendar && !mail.canReply) return
        kind = if (calendar) "calendar_insert" else "mail_reply"
        kindKnown = true
        if (calendar) create(null) else {
            move(ActionStage.DICTATING)
            speak(mail.replyPromptSentences) { if (!demo) listen(CaptureMode.QUESTION) { create(it) } }
        }
    }
    fun demoDictate() { if (demo && dialog.stage == ActionStage.DICTATING) create(null) }
    fun demoVoice() { if (demo && !busy) { kind = "calendar_insert"; candidate = null; create(null) } }
    private fun create(audio: WavAudio?) {
        if (quietMailNotice) { candidate = null; quietMailNotice = false }
        dialog.clearAction(); polls = 0; clarificationUsed = false; mayHaveExecuted = false
        move(ActionStage.PROCESSING)
        val body = ActionProposalRequest(wireTrip(dialog.tripId), UUID.randomUUID().toString(), kind, candidate?.candidateId, audio)
        fetch<ActionProposal>({ gateway.propose(body,it) }, { receive(it) }, { notWritten() })
    }
    /** Fetches a stored turn proposal only after its short acknowledgement has finished playing. */
    fun receivePending(id: String, version: Int, tripId: Long, generation: Long) {
        if (closed || version <= 0 || dialog.tripId != tripId || dialog.generation != generation || busy || dialog.actionId == id) return
        if (quietMailNotice) { candidate = null; quietMailNotice = false }
        kind = "calendar_insert"; kindKnown = true; mayHaveExecuted = false
        dialog.bind(id, version); rememberAction(id); move(ActionStage.PROCESSING)
        fetch<ActionProposal>({ gateway.readback(id, it) }, { value ->
            if (value.actionId != id || value.version != version) {
                pendingReadbackFailed()
            } else receive(value)
        }, { pendingReadbackFailed() })
    }
    private fun pendingReadbackFailed() {
        dialog.actionId?.let { id -> logCancellation(ActionCancelReason.OTHER); gateway.cancel(id) { } }
        stopIO(); proposal = null; outcome = "failed"
        resultText = "일정을 추가하지 않았어요."
        rememberAction(null); move(ActionStage.RESULT)
        speak(local("not_written_calendar", resultText)) {}
    }
    fun receive(value: ActionProposal, kindHint: String? = null) {
        if (closed) return
        if (quietMailNotice) { candidate = null; quietMailNotice = false }
        if (dialog.actionId != null && busy && dialog.actionId != value.actionId) return
        when {
            kindHint != null -> { require(kindHint in setOf("mail_reply", "calendar_insert")); kind = kindHint }
            value.display.title != null -> kind = "calendar_insert"
            value.display.body != null -> kind = "mail_reply"
        }
        kindKnown = true; mayHaveExecuted = false
        if (value.expiresAt <= wallClock()) { finish("expired",emptyList()); return }
        stopIO(); dialog.bind(value.actionId,value.version); rememberAction(value.actionId)
        proposal = value; outcome = null; resultText = ""
        when (value.status) {
            "rejected" -> finish("rejected",value.sentences)
            "needs_clarification" -> {
                if (clarificationUsed) { cancel(ActionCancelReason.OTHER); return }
                move(ActionStage.CLARIFYING)
                speak(value.sentences) { if (!demo) listen(CaptureMode.QUESTION) { clarify(it) } }
            }
            "awaiting_approval" -> {
                if (value.sentences.isEmpty() || value.sentences.any { it.text.isBlank() }) { cancel(ActionCancelReason.OTHER); return }
                move(ActionStage.READBACK)
                speak(value.sentences) {
                    if (wallClock() >= value.expiresAt) { cancel(ActionCancelReason.OTHER); return@speak }
                    dialog.readbackComplete(); changed()
                    arm(6000) { cancel(ActionCancelReason.OTHER) }
                    if (!demo && permitted()) listen(CaptureMode.QUESTION) { approve(it) }
                }
            }
        }
    }
    fun clarify(audio: WavAudio) {
        if (dialog.stage != ActionStage.CLARIFYING || clarificationUsed) return
        clarificationUsed = true; val value = proposal ?: return
        move(ActionStage.PROCESSING)
        fetch<ActionProposal>({ gateway.clarify(value.actionId,value.version,audio,it) }, { response ->
            if (response.actionId == value.actionId && response.version > value.version) receive(response) else cancel(ActionCancelReason.OTHER)
        }, { cancelBeforeApproval() })
    }
    fun approveButton() { if (buttonPermitted() && readbackFinished) approve(null) }
    private fun approve(audio: WavAudio?) {
        val value = proposal ?: return
        if (value.expiresAt <= wallClock() || !dialog.approve()) return
        stopIO(); changed()
        val hash = value.contentHash ?: run { cancel(ActionCancelReason.OTHER); return }
        val sentAt = clock.elapsedRealtimeMillis()
        mayHaveExecuted = true
        fetch<ActionApproval>({ gateway.approve(value.actionId,ActionApprovalRequest(hash,value.version,if (audio == null) "parked_button" else "voice",audio),it) }, { approval ->
            if (approval.actionId != value.actionId) { uncertain(); return@fetch }
            if (approval.status == "not_approved") { finish("not_approved",approval.sentences.orEmpty()); return@fetch }
            val executeAt = approval.executeAt; val serverNow = approval.serverNow
            if (approval.status != "holding" || executeAt == null || serverNow == null) { uncertain(); return@fetch }
            holdUntil = sentAt + (executeAt-serverNow).coerceAtLeast(0)
            move(ActionStage.HOLDING)
            if (!demo && !watchHoldReadiness()) return@fetch
            speak(approval.holdSentences) {
                if (demo) {
                    // Local actions have no external alarm: reserve ten seconds after actual playback completion.
                    holdUntil = maxOf(holdUntil, clock.elapsedRealtimeMillis() + 10000)
                    arm(holdUntil-clock.elapsedRealtimeMillis()) { poll() }
                } else {
                    // Refuse an unmonitored hold if speech consumed the cancellation window.
                    if (holdUntil-clock.elapsedRealtimeMillis() < 10000) { cancel(ActionCancelReason.WINDOW_SHORT); return@speak }
                    listenHold()
                }
            }
        }, { cancel(ActionCancelReason.OTHER) })
    }
    private fun watchHoldReadiness(): Boolean {
        holdWatchdog?.cancel(); holdWatchdog = null
        val untilWatchdog = holdUntil - clock.elapsedRealtimeMillis() - 1500
        if (untilWatchdog <= 0) { cancel(ActionCancelReason.WATCHDOG_UNREADY); return false }
        val token = dialog.token(); val generation = holdCaptureGeneration
        holdWatchdog = schedule(untilWatchdog) {
            if (!closed && dialog.current(token) && generation == holdCaptureGeneration && !holdReady) cancel(ActionCancelReason.WATCHDOG_UNREADY)
        }
        return true
    }
    private fun listenHold() {
        if (dialog.stage != ActionStage.HOLDING) return
        if (!permitted()) { cancel(ActionCancelReason.PERMISSION); return }
        if (!focus()) { cancel(ActionCancelReason.FOCUS); return }
        timer?.cancel(); timer = null; holdReady = false
        val token = dialog.token(); val generation = ++holdCaptureGeneration
        fun current() = !closed && dialog.current(token) && generation == holdCaptureGeneration
        voicePhase = "IDLE"; changed()
        if (!watchHoldReadiness()) return
        try {
            trace("HOLD_LISTEN_START")
            val handle = input.start(CaptureMode.HOLD, { current() && permitted() }, { post {
                // No confirm/STT request is reachable from this callback, even before ready.
                if (current()) cancel(ActionCancelReason.VOICE_ONSET)
            } }, { clip -> post {
                clip.getOrNull()?.wav?.fill(0)
                if (!current()) return@post
                capture = null
                if (clip.isFailure) cancel(ActionCancelReason.CAPTURE_FAILED)
                else if (clip.getOrNull()?.voiced == true) cancel(ActionCancelReason.VOICE_ONSET)
                else listenHold()
            } }, ready = { post {
                if (!current() || holdReady) return@post
                if (!permitted()) { cancel(ActionCancelReason.PERMISSION); return@post }
                if (holdUntil-clock.elapsedRealtimeMillis() < 10000) { cancel(ActionCancelReason.WINDOW_SHORT); return@post }
                holdReady = true; holdWatchdog?.cancel(); holdWatchdog = null
                voicePhase = "LISTENING"; changed()
                // The deadline poll is reachable only after actual recorder readiness.
                arm(holdUntil-clock.elapsedRealtimeMillis()) { poll() }
            } })
            if (current()) capture = handle else handle.cancel()
        } catch (_: Exception) { if (current()) cancel(ActionCancelReason.CAPTURE_EXCEPTION) }
    }
    fun decline() {
        if (dialog.stage != ActionStage.OFFER) return
        candidate = null; finish("declined",emptyList())
    }
    fun cancel(reason: ActionCancelReason = ActionCancelReason.USER) {
        val id = dialog.actionId
        if (id == null) {
            logCancellation(reason)
            if (dialog.stage == ActionStage.OFFER) decline()
            else notWritten()
            return
        }
        if (dialog.stage == ActionStage.CANCELLING || !busy) return
        logCancellation(reason)
        move(ActionStage.CANCELLING)
        fetch<ActionCancel>({ gateway.cancel(id,it) }, { value ->
            if (value.actionId != id) {
                if (mayHaveExecuted) uncertain() else notWritten()
                return@fetch
            }
            if (value.cancelled && value.status == "cancelled") finish("cancelled",emptyList())
            else if (mayHaveExecuted) poll() else notWritten()
        }, { if (mayHaveExecuted) uncertain() else notWritten() })
    }
    fun restore(id: String) { stopIO(); mayHaveExecuted = true; kindKnown = false; rememberAction(id); dialog.restore(id); polls = 0; poll() }
    private fun poll() {
        val id = dialog.actionId ?: return
        move(ActionStage.PROCESSING)
        if (++polls > 24) { uncertain(); return }
        fetch<ActionStatus>({ gateway.status(id,it) }, { status ->
            if (status.actionId != id) { uncertain(); return@fetch }
            kind = status.kind; kindKnown = true
            if (status.status in TERMINAL) finish(status.status,status.sentences.orEmpty())
            else arm(1000) { poll() }
        }, { arm(1000) { poll() } })
    }
    private fun finish(status: String, sentences: List<Sentence>) {
        val followUp = status == "succeeded" && kind == "mail_reply" && candidate?.canAddCalendar == true && !candidate?.calendarOfferSentences.isNullOrEmpty()
        val (fallbackKey, fallbackText) = terminalFallback(status)
        val speech = if (sentences.isNotEmpty()) sentences else if (fallbackKey != null) local(fallbackKey, fallbackText) else emptyList()
        outcome = status; resultText = sentences.joinToString("\n") { it.text }.ifEmpty { fallbackText }
        rememberAction(if (status == "unknown") dialog.actionId else null)
        move(if (status == "unknown") ActionStage.UNKNOWN else ActionStage.RESULT)
        speak(speech) { if (followUp) offer(true) }
    }
    private fun terminalFallback(status: String): Pair<String?, String> {
        val calendar = kind == "calendar_insert"
        val notWritten = if (calendar) "일정을 추가하지 않았어요." else "보내지 않았어요."
        return when (status) {
            "unknown" -> when {
                !kindKnown -> "unknown_generic" to "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 처리하지 않을게요."
                calendar -> "unknown_calendar" to "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요."
                else -> "unknown" to "처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요."
            }
            "failed" -> if (calendar) "failed_calendar" to "일정을 추가하지 못했어요." else "failed_reply" to "보내지 못했어요."
            "cancelled", "expired", "not_approved", "declined", "rejected" ->
                (if (calendar) "not_written_calendar" else "not_written_reply") to notWritten
            else -> null to ""
        }
    }
    private fun notWritten() {
        val (key, text) = terminalFallback("cancelled")
        outcome = "failed"; resultText = text
        rememberAction(null); move(ActionStage.RESULT)
        if (key != null) speak(local(key, text)) {}
    }
    private fun cancelBeforeApproval() {
        val id = dialog.actionId
        logCancellation(ActionCancelReason.OTHER)
        if (id == null) { notWritten(); return }
        fetch<ActionCancel>({ gateway.cancel(id,it) }, { value ->
            if (dialog.actionId == id && !mayHaveExecuted && value.actionId == id && value.cancelled && value.status == "cancelled") {
                finish("cancelled", emptyList())
            } else notWritten()
        }, { notWritten() })
    }
    private fun uncertain() {
        val (key, text) = terminalFallback("unknown")
        outcome = "unknown"; resultText = text; move(ActionStage.UNKNOWN)
        if (key != null) speak(local(key,text)) {}
        // Preserve only actionId for status-only recovery; never retry approval.
    }
    fun safetyChanged() { if (busy && !permitted() && !demo) cancel(ActionCancelReason.PERMISSION) }
    fun interrupt(reason: ActionCancelReason = ActionCancelReason.OTHER) { if (busy) cancel(reason) }
    private fun arm(delay: Long, action: () -> Unit) {
        timer?.cancel(); val token = dialog.token()
        timer = schedule(delay) { if (!closed && dialog.current(token)) action() }
    }
    private fun local(key: String, text: String) = localAudio(key)?.let { listOf(Sentence(text,it)) }.orEmpty()
    private fun speak(sentences: List<Sentence>, done: () -> Unit) {
        val token = dialog.token(); capture?.cancel(); capture = null; listening = false
        fun next(index: Int) {
            if (closed || !dialog.current(token)) return
            if (index >= sentences.size) { voicePhase = "IDLE"; changed(); done(); return }
            if (!focus()) { if (busy) cancel(ActionCancelReason.FOCUS); return }
            voicePhase = "SPEAKING"; changed()
            var began = false; var complete = false
            playbackTimer?.cancel()
            playbackTimer = schedule(45000) { if (dialog.current(token) && !complete) cancel(ActionCancelReason.OTHER) }
            output.play(sentences[index].audio, { post { if (dialog.current(token)) began = true } }, { post {
                if (!dialog.current(token) || complete) return@post
                complete = true; playbackTimer?.cancel()
                if (!began) { cancel(ActionCancelReason.OTHER); return@post }
                next(index+1)
            } }, { post { if (dialog.current(token)) cancel(ActionCancelReason.OTHER) } })
        }
        next(0)
    }
    private fun listen(mode: CaptureMode, done: (WavAudio) -> Unit) {
        val permittedNow = permitted()
        if (!permittedNow || !focus()) {
            if (dialog.stage == ActionStage.OFFER) arm(6000) { decline() }
            else cancel(if (permittedNow) ActionCancelReason.FOCUS else ActionCancelReason.PERMISSION)
            return
        }
        val token = dialog.token(); listening = true; voicePhase = "LISTENING"; changed()
        arm(if (dialog.stage == ActionStage.AWAITING_APPROVAL) 6000 else 8000) { cancel(ActionCancelReason.OTHER) }
        capture = input.start(mode, { !closed && dialog.current(token) && permitted() }, {}, { result -> post {
            if (closed || !dialog.current(token) || !listening) { result.getOrNull()?.wav?.fill(0); return@post }
            listening = false; capture = null; timer?.cancel(); timer = null
            result.fold({ clip ->
                val audio = try { if (clip.voiced) WavAudio(Base64.getEncoder().encodeToString(clip.wav)) else null } finally { clip.wav.fill(0) }
                if (audio == null) cancel(ActionCancelReason.OTHER)
                else if (!permitted()) cancel(ActionCancelReason.PERMISSION)
                else { voicePhase = "THINKING"; changed(); done(audio) }
            }, { cancel(ActionCancelReason.CAPTURE_FAILED) })
        } })
    }
    fun suspend() { stopIO(); dialog.move(ActionStage.IDLE); changed() }
    /** Returning from demo only reconciles the live action; it never repeats approval. */
    fun resume() { if (!closed) recoveryId?.let { restore(it) } }
    private fun rememberAction(id: String?) { recoveryId = id; remember(id) }
    override fun close() { closed = true; stopIO() }
    companion object { val TERMINAL = setOf("succeeded","failed","unknown","cancelled","expired","rejected","not_approved") }
}
