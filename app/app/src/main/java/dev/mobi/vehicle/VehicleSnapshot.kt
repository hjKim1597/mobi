package dev.mobi.vehicle

enum class Gear { UNKNOWN, PARK, DRIVE, REVERSE, NEUTRAL }

data class VehicleSnapshot(
    val gear: Gear = Gear.UNKNOWN,
    val uxKnown: Boolean = false,
    val restricted: Boolean = true,
    val available: Boolean = false,
    val sourceTimestampNanos: Long = 0,
)
