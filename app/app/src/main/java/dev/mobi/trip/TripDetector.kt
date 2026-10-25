package dev.mobi.trip

import dev.mobi.vehicle.Gear

class TripDetector(
    private val clock: Clock,
    private val store: TripStore,
) {
    var snapshot: TripSnapshot = store.load() ?: TripSnapshot()
        private set
    private var bootKnown = snapshot.bootCount >= 0 && snapshot.schemaVersion == CURRENT_SCHEMA
    private var invalidStoredState = snapshot.schemaVersion != CURRENT_SCHEMA

    @Synchronized
    fun onBoot(bootCount: Int?): Boolean {
        if (bootCount == null || bootCount < 0) {
            bootKnown = false
            return false
        }
        if (invalidStoredState) return false
        if (snapshot.bootCount == bootCount) {
            bootKnown = true
            return false
        }
        bootKnown = false

        val next = TripSnapshot(
            bootCount = bootCount,
            tripId = nextTripId(snapshot.tripId),
            gear = Gear.UNKNOWN,
            parkedAtMillis = null,
            firstDeparturePending = true,
            knockConsumed = true,
            muted = false,
            dialogTerminal = "IDLE",
        )
        if (!store.save(next)) return false
        snapshot = next
        bootKnown = true
        return true
    }

    @Synchronized
    fun onGear(gear: Gear): Boolean {
        if (!bootKnown || invalidStoredState || gear == snapshot.gear) return false
        val now = clock.elapsedRealtimeMillis()
        var next = snapshot.copy(gear = gear)
        if (gear == Gear.PARK) {
            if (snapshot.gear != Gear.PARK) next = next.copy(parkedAtMillis = now)
        } else if (gear == Gear.DRIVE) {
            val parkedAt = snapshot.parkedAtMillis
            val qualifies = snapshot.gear == Gear.PARK && parkedAt != null &&
                now >= parkedAt && now - parkedAt >= PARK_THRESHOLD_MILLIS
            if (qualifies && snapshot.firstDeparturePending) {
                next = next.copy(parkedAtMillis = null, firstDeparturePending = false)
            } else if (qualifies) {
                next = next.copy(
                    tripId = nextTripId(snapshot.tripId),
                    parkedAtMillis = null,
                    firstDeparturePending = false,
                    knockConsumed = true,
                    muted = false,
                    dialogTerminal = "IDLE",
                )
                if (!store.save(next)) return false
                snapshot = next
                return true
            } else {
                next = next.copy(parkedAtMillis = null, firstDeparturePending = false)
            }
        } else {
            next = next.copy(parkedAtMillis = null)
        }
        if (!store.save(next)) return false
        snapshot = next
        return false
    }

    @Synchronized
    fun mute(): Boolean {
        if (!bootKnown || invalidStoredState || snapshot.muted) return false
        val next = snapshot.copy(muted = true, dialogTerminal = "MUTED")
        if (!store.save(next)) return false
        snapshot = next
        return true
    }

    @Synchronized
    fun setDialogTerminal(value: String): Boolean {
        if (!bootKnown || invalidStoredState) return false
        val next = snapshot.copy(dialogTerminal = value)
        if (!store.save(next)) return false
        snapshot = next
        return true
    }

    private fun nextTripId(current: Long) = if (current == Long.MAX_VALUE) 1L else current + 1L

    private companion object {
        const val CURRENT_SCHEMA = 1
        const val PARK_THRESHOLD_MILLIS = 600_000L
    }
}
