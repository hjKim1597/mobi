package dev.mobi.dialog

import dev.mobi.vehicle.VehicleSnapshot
import dev.mobi.vehicle.Gear

object SafetyGate {
    fun interactive(snapshot: VehicleSnapshot): Boolean =
        snapshot.available && snapshot.gear == Gear.PARK && snapshot.uxKnown && !snapshot.restricted
}
