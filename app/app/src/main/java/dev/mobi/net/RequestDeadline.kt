package dev.mobi.net

import dev.mobi.trip.Clock
import java.util.concurrent.atomic.AtomicBoolean

fun interface CancelHandle { fun cancel() }

/** One absolute monotonic budget, shared by every stage of a request. */
class RequestDeadline(private val clock: Clock, val expiresAtMillis: Long) {
    private val cancelled = AtomicBoolean(false)
    fun remainingMillis(): Long = if (cancelled.get()) 0 else (expiresAtMillis - clock.elapsedRealtimeMillis()).coerceAtLeast(0)
    val expired: Boolean get() = remainingMillis() == 0L
    fun cancel() { cancelled.set(true) }
}

data class Operation(val tripId: Long, val generation: Long, val serial: Long, val deadline: RequestDeadline)
