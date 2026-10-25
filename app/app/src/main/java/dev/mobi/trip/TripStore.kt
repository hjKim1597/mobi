package dev.mobi.trip

import dev.mobi.vehicle.Gear

data class TripSnapshot(
    val schemaVersion: Int = 1,
    val bootCount: Int = -1,
    val tripId: Long = 0,
    val gear: Gear = Gear.UNKNOWN,
    val parkedAtMillis: Long? = null,
    val firstDeparturePending: Boolean = true,
    val knockConsumed: Boolean = false,
    val muted: Boolean = false,
    val dialogTerminal: String = "IDLE",
)

interface TripStore {
    fun load(): TripSnapshot?
    fun save(snapshot: TripSnapshot): Boolean
}
