package dev.mobi.net

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

data class Capabilities(
    val calendarRead: Boolean,
    val mailRead: Boolean,
    val mailReply: Boolean,
    val calendarInsert: Boolean,
    val reconnectRequired: Boolean,
)

data class ActionDisplay(
    val sender: String? = null,
    val subject: String? = null,
    val summary: String? = null,
    val body: String? = null,
    val to: String? = null,
    val title: String? = null,
    val start: String? = null,
    val end: String? = null,
    val timeZone: String? = null,
) { override fun toString() = "ActionDisplay([redacted])" }

data class MailCandidate(
    val candidateId: String,
    val sensitive: Boolean,
    val canReply: Boolean,
    val canAddCalendar: Boolean,
    val sentences: List<Sentence>,
    val replyPromptSentences: List<Sentence>,
    val calendarOfferSentences: List<Sentence>?,
    val display: ActionDisplay,
) { override fun toString() = "MailCandidate([redacted])" }

data class MailScanResponse(val candidate: MailCandidate?)

data class ActionProposal(
    val actionId: String,
    val version: Int,
    val status: String,
    val contentHash: String?,
    val sentences: List<Sentence>,
    val display: ActionDisplay,
    val expiresAt: Long,
    val reasonCode: String?,
) { override fun toString() = "ActionProposal(actionId=$actionId, version=$version, status=$status, [redacted])" }

data class ActionApproval(
    val actionId: String,
    val status: String,
    val executeAt: Long?,
    val serverNow: Long?,
    val holdSentences: List<Sentence>,
    val reasonCode: String?,
    val sentences: List<Sentence>?,
) { override fun toString() = "ActionApproval(actionId=$actionId, status=$status, [redacted])" }

data class ActionCancel(val actionId: String, val status: String, val cancelled: Boolean)

data class ActionStatus(
    val actionId: String,
    val kind: String,
    val status: String,
    val executeAt: Long?,
    val outcomeCode: String?,
    val sentences: List<Sentence>?,
)

data class ActionProposalRequest(
    val tripId: String,
    val requestId: String,
    val kind: String,
    val candidateId: String? = null,
    val audio: WavAudio? = null,
) { override fun toString() = "ActionProposalRequest([redacted])" }

data class ActionApprovalRequest(
    val contentHash: String,
    val version: Int,
    val channel: String,
    val audio: WavAudio? = null,
) { override fun toString() = "ActionApprovalRequest([redacted])" }

/** Strict decoders for the additive action API; message text is kept only in memory for presentation. */
object ActionApiContract {
    fun mailScanRequestJson(tripId: String, quiet: Boolean): JSONObject = JSONObject().put("tripId", tripId).also {
        if (quiet) it.put("quiet", true)
    }

    private val statuses = setOf("awaiting_approval", "needs_clarification", "holding", "preparing", "sending", "succeeded", "failed", "unknown", "cancelled", "expired", "rejected", "not_approved")

    private fun JSONObject.requiredText(key: String): String = get(key).let { require(it is String); it }
    private fun JSONObject.optionalText(key: String): String? = if (!has(key) || isNull(key)) null else get(key).let { require(it is String); it }
    private fun JSONObject.requiredBoolean(key: String): Boolean = get(key).let { require(it is Boolean); it }
    private fun JSONObject.requiredInt(key: String): Int = get(key).let { require(it is Number && it.toDouble() == it.toInt().toDouble()); it.toInt() }
    private fun JSONObject.optionalTimestamp(key: String): Long? = if (!has(key) || isNull(key)) null else timestamp(get(key))
    private fun timestamp(value: Any): Long = when (value) {
        is Number -> value.toLong().also { require(value.toDouble() == it.toDouble() && it >= 0) }
        is String -> Instant.parse(value).toEpochMilli()
        else -> error("Invalid timestamp")
    }
    private fun uuid(value: String): String = UUID.fromString(value).toString().also { require(it == value.lowercase()) }
    private fun sentences(value: JSONArray): List<Sentence> = (0 until value.length()).map { index ->
        val item = value.getJSONObject(index)
        Sentence(item.requiredText("text"), ApiContract.audio(item.getJSONObject("audio")))
    }
    private fun optionalSentences(j: JSONObject, key: String): List<Sentence>? = if (!j.has(key) || j.isNull(key)) null else sentences(j.getJSONArray(key))
    private fun display(j: JSONObject): ActionDisplay = ActionDisplay(
        sender = j.optionalText("sender"), subject = j.optionalText("subject"), summary = j.optionalText("summary"),
        body = j.optionalText("body"), to = j.optionalText("to"), title = j.optionalText("title"),
        start = j.optionalText("start"), end = j.optionalText("end"), timeZone = j.optionalText("timeZone"),
    )

    fun capabilities(j: JSONObject) = Capabilities(
        j.requiredBoolean("calendarRead"), j.requiredBoolean("mailRead"), j.requiredBoolean("mailReply"),
        j.requiredBoolean("calendarInsert"), j.requiredBoolean("reconnectRequired"),
    )

    fun mailScan(j: JSONObject): MailScanResponse = MailScanResponse(
        if (!j.has("candidate") || j.isNull("candidate")) null else mailCandidate(j.getJSONObject("candidate")),
    )

    fun mailCandidate(j: JSONObject) = MailCandidate(
        candidateId = j.requiredText("candidateId").also { require(it.isNotBlank() && it.length <= 128) },
        sensitive = j.requiredBoolean("sensitive"), canReply = j.requiredBoolean("canReply"),
        canAddCalendar = j.requiredBoolean("canAddCalendar"), sentences = sentences(j.getJSONArray("sentences")),
        replyPromptSentences = sentences(j.getJSONArray("replyPromptSentences")),
        calendarOfferSentences = optionalSentences(j, "calendarOfferSentences"), display = display(j.getJSONObject("display")),
    )

    fun proposal(j: JSONObject): ActionProposal {
        val status = j.requiredText("status"); require(status in setOf("awaiting_approval","needs_clarification","rejected"))
        val hash = j.optionalText("contentHash")
        if (hash != null) require(hash.matches(Regex("[0-9a-f]{64}")))
        val actionId = uuid(j.requiredText("actionId"))
        val version = j.requiredInt("version"); require(version > 0)
        val expiresAt = timestamp(j.get("expiresAt"))
        val spoken = sentences(j.getJSONArray("sentences"))
        if (status == "awaiting_approval") require(hash != null && spoken.isNotEmpty() && spoken.all { it.text.isNotBlank() })
        return ActionProposal(actionId, version, status, hash, spoken, display(j.getJSONObject("display")), expiresAt, j.optionalText("reasonCode"))
    }

    fun approval(j: JSONObject): ActionApproval {
        val status = j.requiredText("status"); require(status in setOf("holding", "not_approved"))
        val executeAt = j.optionalTimestamp("executeAt"); val serverNow = j.optionalTimestamp("serverNow")
        if (status == "holding") require(executeAt != null && serverNow != null && j.has("holdSentences"))
        return ActionApproval(uuid(j.requiredText("actionId")), status, executeAt, serverNow,
            optionalSentences(j, "holdSentences") ?: emptyList(), j.optionalText("reasonCode"), optionalSentences(j, "sentences"))
    }

    fun cancel(j: JSONObject): ActionCancel {
        val status = j.requiredText("status"); require(status in statuses)
        return ActionCancel(uuid(j.requiredText("actionId")), status, j.requiredBoolean("cancelled"))
    }

    fun status(j: JSONObject): ActionStatus {
        val status = j.requiredText("status"); require(status in statuses)
        val kind = j.requiredText("kind"); require(kind in setOf("mail_reply", "calendar_insert"))
        return ActionStatus(uuid(j.requiredText("actionId")), kind, status, j.optionalTimestamp("executeAt"),
            j.optionalText("outcomeCode"), optionalSentences(j, "sentences"))
    }

    fun proposalJson(value: ActionProposalRequest): JSONObject {
        require(value.tripId.isNotBlank() && value.tripId.length <= 128)
        uuid(value.requestId)
        require(value.kind in setOf("mail_reply", "calendar_insert"))
        require(value.candidateId == null || value.candidateId.isNotBlank() && value.candidateId.length <= 128)
        when (value.kind) {
            "mail_reply" -> require(value.candidateId != null && value.audio != null)
            "calendar_insert" -> require(value.candidateId != null || value.audio != null)
        }
        return JSONObject().put("tripId", value.tripId).put("requestId", value.requestId).put("kind", value.kind)
            .apply { value.candidateId?.let { put("candidateId", it) }; value.audio?.let { put("audio", ApiContract.audioJson(it)) } }
    }

    fun approvalJson(value: ActionApprovalRequest): JSONObject {
        require(value.contentHash.matches(Regex("[0-9a-f]{64}")) && value.version > 0 && value.channel in setOf("voice", "parked_button"))
        return JSONObject().put("contentHash", value.contentHash).put("version", value.version).put("channel", value.channel)
            .apply { value.audio?.let { put("audio", ApiContract.audioJson(it)) } }
    }
}
