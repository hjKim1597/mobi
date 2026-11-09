package dev.mobi.dialog

/** Independent of briefing state. Only identifiers may survive process death. */
enum class ActionStage { IDLE, OFFER, DICTATING, CLARIFYING, READBACK, AWAITING_APPROVAL, APPROVING, HOLDING, CANCELLING, PROCESSING, RESULT, UNKNOWN }
data class ActionToken(val tripId: Long, val generation: Long, val serial: Long, val actionId: String?, val version: Int)

class ActionDialog {
    var stage = ActionStage.IDLE; private set
    var tripId = Long.MIN_VALUE; private set
    var generation = 0L; private set
    var actionId: String? = null; private set
    var version = 0; private set
    private var serial = 0L
    private var offered = false
    private var approved = false
    fun begin(tripId: Long, generation: Long) {
        if (this.tripId != tripId) offered = false
        this.tripId = tripId; this.generation = generation
        actionId = null; version = 0; approved = false; move(ActionStage.IDLE)
    }
    fun claimOffer(): Boolean { if (offered) return false; offered = true; return true }
    fun markOffered() { offered = true }
    fun token() = ActionToken(tripId, generation, serial, actionId, version)
    fun current(token: ActionToken) = token == token()
    fun move(next: ActionStage) { stage = next; serial++ }
    fun bind(id: String, version: Int) {
        if (actionId != id || this.version != version) approved = false
        actionId = id; this.version = version; serial++
    }
    fun clearAction() { actionId = null; version = 0; approved = false; serial++ }
    fun readbackComplete() { if (stage == ActionStage.READBACK) move(ActionStage.AWAITING_APPROVAL) }
    fun approve(): Boolean {
        if (stage != ActionStage.AWAITING_APPROVAL || approved) return false
        approved = true; move(ActionStage.APPROVING); return true
    }
    fun restore(id: String) { actionId = id; approved = true; move(ActionStage.PROCESSING) }
}
