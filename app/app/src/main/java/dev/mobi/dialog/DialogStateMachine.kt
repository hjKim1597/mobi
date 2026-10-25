package dev.mobi.dialog

import dev.mobi.voice.Intent

enum class DialogState { IDLE, KNOCKING, AWAITING_RESPONSE, BRIEFING, DEFERRED, MUTED }

class DialogStateMachine {
    var state: DialogState = DialogState.IDLE
        private set
    var tripId: Long = 0L
        private set
    var generation: Long = 0L
        private set
    var muted: Boolean = false
        private set

    private var responseDeadlineMillis: Long? = null

    fun startTrip(id: Long, nowMillis: Long) {
        tripId = id
        generation += 1
        state = DialogState.KNOCKING
        muted = false
        responseDeadlineMillis = null
    }

    fun knockFinished(id: Long, generation: Long, nowMillis: Long) {
        if (id != tripId || generation != this.generation || state != DialogState.KNOCKING) return
        state = DialogState.AWAITING_RESPONSE
        responseDeadlineMillis = nowMillis + RESPONSE_TIMEOUT_MILLIS
    }

    fun onFinalSentence(id: Long, sentence: String) {
        respond(id, Intent.classify(sentence))
    }

    fun respond(id: Long, intent: Intent) {
        if (id != tripId) return
        when (intent) {
            Intent.ACCEPT -> if (state == DialogState.AWAITING_RESPONSE) state = DialogState.BRIEFING
            Intent.DECLINE -> {
                if (state in ACTIVE_STATES) {
                    state = DialogState.MUTED
                    muted = true
                }
            }
            Intent.CANCEL -> if (state in ACTIVE_STATES) state = DialogState.DEFERRED
            Intent.NOT_NOW -> if (state == DialogState.AWAITING_RESPONSE) state = DialogState.DEFERRED
            Intent.SEND, Intent.CHANGE -> Unit
        }
        if (state != DialogState.AWAITING_RESPONSE) responseDeadlineMillis = null
    }

    fun voiceStarted(id: Long, generation: Long) {
        if (id == tripId && generation == this.generation && state == DialogState.AWAITING_RESPONSE) responseDeadlineMillis = null
    }

    fun defer(id: Long, generation: Long) {
        if (id != tripId || generation != this.generation || state == DialogState.MUTED) return
        state = DialogState.DEFERRED
        responseDeadlineMillis = null
    }

    fun complete(id: Long, generation: Long) {
        if (id != tripId || generation != this.generation || state == DialogState.MUTED) return
        state = DialogState.IDLE
        responseDeadlineMillis = null
    }

    fun question() {
        if (muted) return
        generation += 1
        state = DialogState.BRIEFING
        responseDeadlineMillis = null
    }

    fun onDriving(micReady: Boolean) {
        if (!micReady && (state == DialogState.KNOCKING || state == DialogState.AWAITING_RESPONSE)) {
            state = DialogState.DEFERRED
            responseDeadlineMillis = null
        }
    }

    fun tick(nowMillis: Long) {
        val deadline = responseDeadlineMillis ?: return
        if (nowMillis >= deadline && state == DialogState.AWAITING_RESPONSE) {
            state = DialogState.DEFERRED
            responseDeadlineMillis = null
        }
    }

    fun restore(id: Long, muted: Boolean, terminal: String = "IDLE") {
        tripId = id
        generation += 1
        this.muted = muted
        state = if (muted) DialogState.MUTED else when (terminal) {
            DialogState.IDLE.name -> DialogState.IDLE
            DialogState.BRIEFING.name -> DialogState.BRIEFING
            DialogState.DEFERRED.name,
            DialogState.KNOCKING.name,
            DialogState.AWAITING_RESPONSE.name -> DialogState.DEFERRED
            else -> DialogState.DEFERRED
        }
        responseDeadlineMillis = null
    }

    private companion object {
        const val RESPONSE_TIMEOUT_MILLIS = 6_000L
        val ACTIVE_STATES = setOf(DialogState.KNOCKING, DialogState.AWAITING_RESPONSE, DialogState.BRIEFING)
    }
}
