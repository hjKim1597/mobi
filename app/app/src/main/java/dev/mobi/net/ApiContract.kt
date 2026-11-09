package dev.mobi.net

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.time.LocalDate
import java.time.ZoneId
import java.util.Base64
import java.util.UUID

data class DeviceCredentials(val deviceId: String, val deviceToken: String)
data class PairingCreated(val code: String, val pairingUrl: String, val expiresAt: String)
data class PairingStatus(val status: String, val expiresAt: String)
data class CalendarEvent(val id: String, val title: String, val start: String, val end: String, val allDay: Boolean, val location: String? = null)
data class KnockAudio(val text: String, val audio: WavAudio, val sha256: String)
data class KnockBundle(val version: String, val date: String, val timeZone: String, val eventCount: Int, val online: KnockAudio, val offline: KnockAudio)
data class TodayResponse(val date: String, val timeZone: String, val events: List<CalendarEvent>, val knock: KnockBundle)
data class BriefingRequest(val tripId: String, val remainingSeconds: Int?)
data class BriefingResponse(val briefingId: String, val tripId: String, val bucket: String, val text: String, val audio: WavAudio)
data class ConfirmMatch(val label: String, val action: String, val mode: String)
data class ConfirmResponse(val transcript: String, val match: ConfirmMatch)
data class Sentence(val text: String, val audio: WavAudio) { override fun toString() = "Sentence([redacted])" }
data class ActionProposalPending(val actionId: String, val version: Int)
data class TurnResponse(val turnId: String, val transcript: String, val sentences: List<Sentence>, val actionProposal: ActionProposal? = null,
    val actionProposalPending: ActionProposalPending? = null)
class ApiFailure(val status: Int, val code: String, val retryAfterSeconds: Long = 0) : Exception("HTTP $status $code")

data class WavAudio(val data: String, val mimeType: String = "audio/wav") {
    fun bytes(): ByteArray {
        require(mimeType == "audio/wav" && data.length in 4..2_796_204 && data.length % 4 == 0)
        require(data.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")))
        val bytes = Base64.getDecoder().decode(data)
        require(bytes.size in 44..2_097_152)
        require(String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WAVE")
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require((b.getInt(4).toLong() and 0xffffffffL) + 8 == bytes.size.toLong())
        var offset = 12; var format = false; var pcm = false
        while (offset + 8 <= bytes.size) {
            val size = b.getInt(offset + 4).toLong() and 0xffffffffL
            val end = offset + 8L + size
            require(end <= bytes.size)
            when (String(bytes, offset, 4, Charsets.US_ASCII)) {
                "fmt " -> { require(!format && size >= 16); require(b.getShort(offset + 8).toInt() == 1)
                    require(b.getShort(offset + 10).toInt() in 1..2 && b.getInt(offset + 12) > 0 && b.getShort(offset + 22).toInt() == 16); format = true }
                "data" -> { require(!pcm && size > 0 && size % 2 == 0L); pcm = true }
            }
            offset = (end + size % 2).toInt()
        }
        require(format && pcm && offset == bytes.size)
        return bytes
    }
}

/** All wire keys live here. Additive fields are intentionally ignored. */
object ApiContract {
    private val confirmLabels = setOf("응", "네", "됐어", "보내", "취소", "하지 마", "아니", "그래", "들려줘", "나중에",
        "조용히", "그만", "괜찮아", "보내줘", "바꿔", "바꿔줘", "보내지 마", "바꾸지 마", "말해줘", "안내해줘", "NONE")
    private fun JSONObject.text(key: String): String { val v = get(key); require(v is String); return v }
    private fun JSONObject.number(key: String): Int { val v = get(key); require(v is Number && v.toDouble() == v.toInt().toDouble()); return v.toInt() }
    private fun uuid(value: String): String { UUID.fromString(value); return value }
    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun credentials(j: JSONObject) = DeviceCredentials(uuid(j.text("deviceId")), j.text("deviceToken")).also {
        require(it.deviceToken.matches(Regex("${Regex.escape(it.deviceId)}\\.[0-9a-f]{64}")))
    }
    fun pairing(j: JSONObject) = PairingCreated(j.text("code"), j.text("pairingUrl"), j.text("expiresAt")).also {
        require(it.code.matches(Regex("[A-Za-z0-9_-]{6,64}"))); java.time.Instant.parse(it.expiresAt)
    }
    fun pairingStatus(j: JSONObject) = PairingStatus(j.text("status"), j.text("expiresAt")).also {
        require(it.status in setOf("pending", "processing", "paired", "failed")); java.time.Instant.parse(it.expiresAt)
    }
    fun audio(j: JSONObject) = WavAudio(j.text("data"), j.text("mimeType")).also { it.bytes() }
    private fun knockAudio(j: JSONObject) = KnockAudio(j.text("text"), audio(j.getJSONObject("audio")), j.text("sha256")).also {
        require(it.sha256.matches(Regex("[0-9a-f]{64}")) && sha256(it.audio.bytes()) == it.sha256)
    }
    fun today(j: JSONObject): TodayResponse {
        val date = j.text("date"); LocalDate.parse(date)
        val zone = j.text("timeZone"); ZoneId.of(zone)
        val events = j.getJSONArray("events").let { a -> (0 until a.length()).map { index ->
            val e = a.getJSONObject(index); val start = e.getJSONObject("start"); val end = e.getJSONObject("end")
            val allDay = start.has("date"); val key = if (allDay) "date" else "dateTime"
            val s = start.text(key); val t = end.text(key)
            if (allDay) { LocalDate.parse(s); LocalDate.parse(t) } else { java.time.OffsetDateTime.parse(s); java.time.OffsetDateTime.parse(t) }
            CalendarEvent(e.text("id"), e.text("title"), s, t, allDay, if (e.has("location")) e.text("location") else null)
        } }
        val k = j.getJSONObject("knock")
        val bundle = KnockBundle(k.text("version"), k.text("date"), k.text("timeZone"), k.number("eventCount"), knockAudio(k.getJSONObject("online")), knockAudio(k.getJSONObject("offline")))
        require(bundle.version == "knock-v1" && bundle.date == date && bundle.timeZone == zone && bundle.eventCount == events.size)
        return TodayResponse(date, zone, events, bundle)
    }
    fun todayJson(value: TodayResponse): JSONObject {
        fun spoken(v: KnockAudio) = JSONObject().put("text", v.text).put("sha256", v.sha256).put("audio", audioJson(v.audio))
        val k = value.knock
        return JSONObject().put("date", value.date).put("timeZone", value.timeZone).put("events", JSONArray(value.events.map { e ->
            val key = if (e.allDay) "date" else "dateTime"
            JSONObject().put("id", e.id).put("title", e.title).put("start", JSONObject().put(key, e.start)).put("end", JSONObject().put(key, e.end)).apply { e.location?.let { put("location", it) } }
        })).put("knock", JSONObject().put("version", k.version).put("date", k.date).put("timeZone", k.timeZone).put("eventCount", k.eventCount).put("online", spoken(k.online)).put("offline", spoken(k.offline)))
    }
    fun briefing(j: JSONObject) = BriefingResponse(uuid(j.text("briefingId")), j.text("tripId"), j.text("bucket"), j.text("text"), audio(j.getJSONObject("audio"))).also { require(it.bucket in setOf("short", "summary", "full")) }
    fun confirm(j: JSONObject): ConfirmResponse {
        val m = j.getJSONObject("match")
        val match = ConfirmMatch(m.text("label"), m.text("action"), m.text("mode"))
        require(match.label in confirmLabels)
        require(match.action in setOf("LISTEN", "NOT_NOW", "SEND", "CHANGE", "CANCEL") && match.mode in setOf("exact", "fuzzy-safe", "none"))
        return ConfirmResponse(j.text("transcript"), match)
    }
    fun turn(j: JSONObject): TurnResponse {
        val a = j.getJSONArray("sentences"); require(a.length() <= 1)
        val transcript = j.text("transcript")
        val sentences = (0 until a.length()).map { val s = a.getJSONObject(it); Sentence(s.text("text"), audio(s.getJSONObject("audio"))) }
        require(transcript.isNotEmpty() || sentences.isEmpty())
        val proposal = if (!j.has("actionProposal") || j.isNull("actionProposal")) null else ActionApiContract.proposal(j.getJSONObject("actionProposal"))
        val pending = if (!j.has("actionProposalPending") || j.isNull("actionProposalPending")) null else j.getJSONObject("actionProposalPending").let {
            ActionProposalPending(uuid(it.text("actionId")), it.number("version")).also { value -> require(value.version > 0) }
        }
        require(proposal == null || pending == null)
        return TurnResponse(uuid(j.text("turnId")), transcript, sentences, proposal, pending)
    }
    fun audioJson(v: WavAudio) = JSONObject().put("data", v.data).put("mimeType", v.mimeType)
    fun briefingJson(v: BriefingRequest) = JSONObject().put("tripId", v.tripId).put("remainingSeconds", v.remainingSeconds ?: JSONObject.NULL)
}
