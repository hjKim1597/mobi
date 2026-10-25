package dev.mobi.net

import android.os.SystemClock
import dev.mobi.trip.Clock
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class ApiClient(val baseUrl: String, allowLoopback: Boolean = false, private val clock: Clock = Clock { SystemClock.elapsedRealtime() }) : AutoCloseable {
    private val pool = Executors.newFixedThreadPool(3)
    private val timers = Executors.newSingleThreadScheduledExecutor()
    private val handles = java.util.concurrent.CopyOnWriteArraySet<CancelHandle>()
    private val origin = URI(baseUrl)
    init {
        require(origin.rawUserInfo == null && origin.rawQuery == null && origin.rawFragment == null && origin.path.orEmpty() in setOf("", "/"))
        require(origin.scheme == "https" || allowLoopback && origin.scheme == "http" && origin.host in setOf("127.0.0.1", "localhost"))
    }
    fun deadline() = RequestDeadline(clock, clock.elapsedRealtimeMillis() + 6000)
    fun register(d: RequestDeadline, cb: (Result<DeviceCredentials>) -> Unit) = request("POST", "/v1/devices", JSONObject(), null, d, ApiContract::credentials, cb)
    fun createPairing(c: DeviceCredentials, d: RequestDeadline, cb: (Result<PairingCreated>) -> Unit) = request("POST", "/v1/pairing", JSONObject(), c, d, { j ->
        ApiContract.pairing(j).also { p -> val u = URI(p.pairingUrl); require(u.scheme == origin.scheme && u.host == origin.host && u.port == origin.port && u.rawUserInfo == null && u.rawQuery == null && u.rawFragment == null && u.path == "/pair/${p.code}") }
    }, cb)
    fun pollPairing(code: String, c: DeviceCredentials, d: RequestDeadline, cb: (Result<PairingStatus>) -> Unit): CancelHandle {
        require(code.matches(Regex("[A-Za-z0-9_-]{6,64}")))
        return request("GET", "/v1/pairing/$code", null, c, d, ApiContract::pairingStatus, cb)
    }
    fun today(c: DeviceCredentials, d: RequestDeadline, cb: (Result<TodayResponse>) -> Unit) = request("GET", "/v1/today", null, c, d, ApiContract::today, cb)
    fun briefing(v: BriefingRequest, c: DeviceCredentials, d: RequestDeadline, cb: (Result<BriefingResponse>) -> Unit) = request("POST", "/v1/briefings", ApiContract.briefingJson(v), c, d, { j ->
        ApiContract.briefing(j).also { require(it.tripId == v.tripId && it.bucket == dev.mobi.vehicle.NaviSource.bucket(v.remainingSeconds)) }
    }, cb)
    fun confirm(audio: WavAudio, c: DeviceCredentials, d: RequestDeadline, cb: (Result<ConfirmResponse>) -> Unit) = request("POST", "/v1/confirm", JSONObject().put("audio", ApiContract.audioJson(audio)), c, d, ApiContract::confirm, cb)
    fun turn(tripId: String, audio: WavAudio, c: DeviceCredentials, d: RequestDeadline, cb: (Result<TurnResponse>) -> Unit) = request("POST", "/v1/turns", JSONObject().put("tripId", tripId).put("audio", ApiContract.audioJson(audio)), c, d, ApiContract::turn, cb)

    private fun <T> request(method: String, path: String, body: JSONObject?, auth: DeviceCredentials?, deadline: RequestDeadline, decode: (JSONObject) -> T, cb: (Result<T>) -> Unit): CancelHandle {
        val done = AtomicBoolean(false); val connection = AtomicReference<HttpURLConnection?>()
        lateinit var handle: CancelHandle
        val alarm = AtomicReference<java.util.concurrent.ScheduledFuture<*>?>()
        fun finish(value: Result<T>) {
            if (done.compareAndSet(false, true)) {
                alarm.get()?.cancel(false); connection.get()?.disconnect(); handles.remove(handle); cb(value)
            }
        }
        handle = CancelHandle { if (done.compareAndSet(false, true)) {
            deadline.cancel(); alarm.get()?.cancel(false); connection.get()?.disconnect(); handles.remove(handle)
        } }
        handles.add(handle)
        alarm.set(timers.schedule({ finish(Result.failure(ApiFailure(0, "TIMEOUT"))) }, deadline.remainingMillis(), TimeUnit.MILLISECONDS))
        pool.execute {
            var requestBytes: ByteArray? = null
            var responseBuffer: ByteArray? = null
            val output = ByteArrayOutputStream()
            try {
                check(!deadline.expired && !done.get())
                val c = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
                connection.set(c)
                if (done.get() || deadline.expired) { c.disconnect(); return@execute }
                c.instanceFollowRedirects = false; c.requestMethod = method
                c.connectTimeout = deadline.remainingMillis().coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
                c.readTimeout = c.connectTimeout
                c.setRequestProperty("Accept", "application/json")
                auth?.let { c.setRequestProperty("Authorization", "Bearer ${it.deviceToken}") }
                body?.let { j ->
                    check(!done.get())
                    requestBytes = j.toString().toByteArray(Charsets.UTF_8)
                    val bytes = requireNotNull(requestBytes); require(bytes.size <= 512 * 1024)
                    c.doOutput = true; c.setFixedLengthStreamingMode(bytes.size); c.setRequestProperty("Content-Type", "application/json")
                    c.outputStream.use { it.write(bytes) }
                    bytes.fill(0); requestBytes = null
                }
                val status = c.responseCode
                val stream = if (status in 200..299) c.inputStream else c.errorStream
                stream?.use { input ->
                    val buffer = ByteArray(8192).also { responseBuffer = it }
                    while (true) {
                        check(!done.get() && !deadline.expired)
                        c.readTimeout = deadline.remainingMillis().coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
                        val count = input.read(buffer); if (count < 0) break
                        require(output.size() + count <= 8 * 1024 * 1024); output.write(buffer, 0, count)
                    }
                }
                check(!deadline.expired && !done.get())
                val json = JSONObject(output.toString("UTF-8"))
                if (status !in 200..299) {
                    val error = json.getJSONObject("error")
                    throw ApiFailure(status, error.getString("code"), json.optLong("retryAfterSeconds", 0))
                }
                val value = decode(json)
                check(!deadline.expired)
                finish(Result.success(value))
            } catch (e: Exception) {
                finish(Result.failure(if (e is ApiFailure) e else ApiFailure(0, if (deadline.expired) "TIMEOUT" else "UNAVAILABLE")))
            } finally {
                requestBytes?.fill(0)
                responseBuffer?.fill(0)
                connection.get()?.disconnect()
            }
        }
        return handle
    }
    override fun close() { handles.toList().forEach { it.cancel() }; pool.shutdownNow(); timers.shutdownNow() }
}
