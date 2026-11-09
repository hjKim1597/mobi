package dev.mobi.trip

import dev.mobi.vehicle.Gear

/** In-memory preference for one drive, reset after the trip's qualifying parked interval. */
class QuietMailSetting {
    var enabled: Boolean = false
        private set
    private var tripStarted = false
    private var parkedAtMillis: Long? = null

    fun set(value: Boolean, nowMillis: Long) {
        parkedAtMillis?.let { finishTrip(it, nowMillis) }
        enabled = value
    }

    /** Returns the parked timestamp when a moving trip has just arrived. */
    fun onGear(gear: Gear, nowMillis: Long): Long? {
        parkedAtMillis?.let { finishTrip(it, nowMillis) }
        if (gear in setOf(Gear.DRIVE, Gear.REVERSE, Gear.NEUTRAL)) {
            tripStarted = true
            parkedAtMillis = null
        }
        if (gear != Gear.PARK || !tripStarted) return null
        tripStarted = false
        parkedAtMillis = nowMillis
        return nowMillis
    }

    fun finishTrip(parkedAtMillis: Long, nowMillis: Long): Boolean {
        if (this.parkedAtMillis != parkedAtMillis || nowMillis - parkedAtMillis < TripDetector.PARK_THRESHOLD_MILLIS) return false
        enabled = false
        this.parkedAtMillis = null
        return true
    }
}
