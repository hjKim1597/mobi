package dev.mobi.dialog

import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import org.junit.Assert.*
import org.junit.Test

class SafetyGateTest {
    @Test fun onlyKnownUnrestrictedParkWithConnectedCarAllowsInteraction() {
        assertTrue(SafetyGate.interactive(VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true)))
        assertFalse(SafetyGate.interactive(VehicleSnapshot()))
        assertFalse(SafetyGate.interactive(VehicleSnapshot(Gear.PARK, uxKnown = false, restricted = false, available = true)))
        assertFalse(SafetyGate.interactive(VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = true, available = true)))
        assertFalse(SafetyGate.interactive(VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = false)))
    }

    @Test fun anyNonParkGearIsClosedEvenWhenUxIsClear() {
        listOf(Gear.UNKNOWN, Gear.DRIVE, Gear.REVERSE, Gear.NEUTRAL).forEach { gear ->
            assertFalse("$gear", SafetyGate.interactive(VehicleSnapshot(gear, true, false, true)))
        }
    }
}
