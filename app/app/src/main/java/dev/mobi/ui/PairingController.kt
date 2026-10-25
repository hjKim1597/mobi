package dev.mobi.ui

import dev.mobi.net.*
import dev.mobi.trip.Clock
import java.time.Instant

data class PairingView(val status: String = "idle", val url: String? = null)

/** Called on the service state thread, including all endpoint callbacks. */
class PairingController(
    private val clock: Clock,
    private val wall: () -> Long,
    private val credentials: () -> DeviceCredentials?,
    private val register: (RequestDeadline, (Result<DeviceCredentials>) -> Unit) -> CancelHandle,
    private val save: (DeviceCredentials) -> Unit,
    private val create: (DeviceCredentials, RequestDeadline, (Result<PairingCreated>) -> Unit) -> CancelHandle,
    private val poll: (String, DeviceCredentials, RequestDeadline, (Result<PairingStatus>) -> Unit) -> CancelHandle,
    private val schedule: (Long, () -> Unit) -> CancelHandle,
    private val changed: (PairingView) -> Unit,
) {
    private var generation = 0L
    private var busy = false
    private var request: CancelHandle? = null
    private var next: CancelHandle? = null
    private var expiry: CancelHandle? = null
    private var until = 0L
    private var retryAt = 0L
    fun begin() {
        if (busy || clock.elapsedRealtimeMillis() < retryAt) return
        cancel(); busy = true
        val id = generation
        changed(PairingView("registering"))
        val existing = credentials()
        if (existing != null) create(id, existing) else {
            request = register(deadline()) { result ->
                if (id != generation) return@register
                result.fold({ value ->
                    runCatching { save(value) }.fold({ create(id, value) }, { fail(id, it) })
                }, { fail(id, it) })
            }
        }
    }
    private fun deadline() = RequestDeadline(clock, clock.elapsedRealtimeMillis() + 6000)
    private fun create(id: Long, c: DeviceCredentials) {
        if (id != generation) return
        request = create(c, deadline()) { result ->
            if (id != generation) return@create
            result.fold({ value ->
                val remaining = (Instant.parse(value.expiresAt).toEpochMilli() - wall()).coerceIn(0, 300000)
                until = clock.elapsedRealtimeMillis() + remaining
                if (remaining == 0L) { finish("expired"); return@fold }
                changed(PairingView("pending", value.pairingUrl))
                expiry = schedule(remaining) { if (id == generation) finish("expired") }
                fun later() {
                    next = schedule(2000) {
                        if (id != generation || clock.elapsedRealtimeMillis() >= until) return@schedule
                        request = poll(value.code, c, deadline()) { status ->
                            if (id != generation) return@poll
                            status.fold({ s ->
                                when (s.status) {
                                    "paired", "failed" -> finish(s.status)
                                    else -> { changed(PairingView(s.status, value.pairingUrl)); later() }
                                }
                            }, { fail(id, it) })
                        }
                    }
                }
                later()
            }, { fail(id, it) })
        }
    }
    private fun fail(id: Long, error: Throwable) {
        if (id != generation) return
        if (error is ApiFailure && error.status == 429) retryAt = clock.elapsedRealtimeMillis() + error.retryAfterSeconds.coerceAtLeast(1) * 1000
        finish(if (error is ApiFailure && error.status == 410) "expired" else "failed")
    }
    private fun finish(status: String) { cancel(); changed(PairingView(status)) }
    fun cancel() {
        generation++; busy = false
        request?.cancel(); next?.cancel(); expiry?.cancel()
        request = null; next = null; expiry = null
        changed(PairingView())
    }
}
