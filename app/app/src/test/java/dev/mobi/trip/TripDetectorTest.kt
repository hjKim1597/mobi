package dev.mobi.trip

import dev.mobi.vehicle.Gear
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TripDetectorTest {
    @Test
    fun confirmedBootCreatesExactlyOneBootKnockAndFirstDepartureDoesNotRepeatIt() {
        val (detector, _, _) = detector()

        assertTrue(detector.onBoot(7))
        assertFalse(detector.onBoot(7))
        assertFalse(detector.onGear(Gear.PARK))
        assertFalse(detector.onGear(Gear.DRIVE))
        assertFalse(detector.onGear(Gear.DRIVE))
        assertEquals(1L, detector.snapshot.tripId)
        assertTrue(detector.snapshot.knockConsumed)
        assertFalse(detector.snapshot.firstDeparturePending)
    }

    @Test
    fun parkForThreeMinutesDoesNotKnock() {
        val (detector, clock) = departedBoot()
        detector.onGear(Gear.PARK)
        clock.advanceBy(180_000)

        assertFalse(detector.onGear(Gear.DRIVE))
    }

    @Test
    fun tenMinuteBoundaryIsInclusiveAndRepeatedParkDoesNotRestartTimer() {
        val (detector, clock) = departedBoot()
        detector.onGear(Gear.PARK)
        clock.advanceBy(300_000)
        detector.onGear(Gear.PARK)
        clock.advanceBy(299_999)
        assertFalse(detector.onGear(Gear.DRIVE))

        detector.onGear(Gear.PARK)
        clock.advanceBy(600_000)
        assertTrue(detector.onGear(Gear.DRIVE))
        assertFalse(detector.onGear(Gear.DRIVE))
    }

    @Test
    fun firstDepartureAfterTenMinuteParkStillDoesNotRepeatBootKnock() {
        val (detector, clock) = detector()
        assertTrue(detector.onBoot(4))
        detector.onGear(Gear.PARK)
        clock.advanceBy(600_000)

        assertFalse(detector.onGear(Gear.DRIVE))
    }

    @Test
    fun reverseBeforeFirstDriveDoesNotConsumeFirstDepartureSuppression() {
        val (detector, clock) = detector()
        assertTrue(detector.onBoot(5))
        assertFalse(detector.onGear(Gear.REVERSE))
        detector.onGear(Gear.PARK)
        clock.advanceBy(600_000)

        assertFalse(detector.onGear(Gear.DRIVE))
        assertFalse(detector.snapshot.firstDeparturePending)
        assertEquals(1L, detector.snapshot.tripId)
    }

    @Test
    fun eachNonParkGearEndsParkInterval() {
        for (interruption in listOf(Gear.REVERSE, Gear.NEUTRAL, Gear.UNKNOWN)) {
            val (detector, clock) = departedBoot()
            detector.onGear(Gear.PARK)
            clock.advanceBy(599_999)
            detector.onGear(interruption)
            detector.onGear(Gear.PARK)
            clock.advanceBy(1)

            assertFalse("$interruption must reset continuous parking", detector.onGear(Gear.DRIVE))
        }
    }

    @Test
    fun successfulDepartureStartsNextTripAndMuteIsScopedToTrip() {
        val (detector, clock) = departedBoot()
        detector.onGear(Gear.PARK)
        clock.advanceBy(600_000)
        assertTrue(detector.onGear(Gear.DRIVE))
        assertTrue(detector.mute())
        assertTrue(detector.snapshot.muted)

        detector.onGear(Gear.PARK)
        clock.advanceBy(600_000)
        assertTrue(detector.onGear(Gear.DRIVE))
        assertFalse(detector.snapshot.muted)
        assertEquals(3L, detector.snapshot.tripId)
    }

    @Test
    fun restartRestoresBootTripAndMuteWithoutRepeatingKnock() {
        val clock = FakeClock()
        val store = MemoryTripStore()
        val first = TripDetector(clock, store)
        assertTrue(first.onBoot(8))
        first.onGear(Gear.DRIVE)
        assertTrue(first.mute())

        val reopened = TripDetector(clock, store)
        assertFalse(reopened.onBoot(8))
        assertTrue(reopened.snapshot.muted)
        assertFalse(reopened.onGear(Gear.DRIVE))
    }

    @Test
    fun newBootDiscardsOldParkTimeAndCreatesOneFreshBootTrip() {
        val clock = FakeClock(900_000)
        val store = MemoryTripStore()
        val first = TripDetector(clock, store)
        assertTrue(first.onBoot(10))
        first.onGear(Gear.DRIVE)
        first.onGear(Gear.PARK)

        val afterReboot = TripDetector(FakeClock(0), store)
        assertTrue(afterReboot.onBoot(11))
        assertEquals(null, afterReboot.snapshot.parkedAtMillis)
        assertFalse(afterReboot.onBoot(11))
    }

    @Test
    fun unavailableBootCountFailsClosedAndDoesNotDestroyExistingSnapshot() {
        val store = MemoryTripStore(TripSnapshot(bootCount = 12, tripId = 5, muted = true))
        val detector = TripDetector(FakeClock(), store)

        assertFalse(detector.onBoot(null))
        assertTrue(detector.snapshot.muted)
        assertEquals(5L, store.load()?.tripId)
        assertFalse(detector.onGear(Gear.PARK))
        assertFalse(detector.onGear(Gear.DRIVE))
        assertEquals(5L, store.load()?.tripId)
    }

    @Test
    fun invalidStoredSchemaCannotBeReplacedByAFreshBootTrip() {
        val corrupt = TripSnapshot(schemaVersion = Int.MIN_VALUE, bootCount = -1, muted = true)
        val store = MemoryTripStore(corrupt)
        val detector = TripDetector(FakeClock(), store)

        assertFalse(detector.onBoot(30))
        assertFalse(detector.onGear(Gear.DRIVE))
        assertEquals(corrupt, detector.snapshot)
        assertEquals(corrupt, store.load())
    }

    @Test
    fun failedCommitNeverEmitsKnockOrClaimsMuteWasSaved() {
        val store = MemoryTripStore()
        val detector = TripDetector(FakeClock(), store)
        store.failWrites = true

        assertFalse(detector.onBoot(20))
        assertFalse(detector.snapshot.knockConsumed)
        assertFalse(detector.mute())
        assertFalse(detector.snapshot.muted)
    }

    @Test
    fun failedNewBootCommitCannotReusePreviousBootParkTime() {
        val stored = TripSnapshot(
            bootCount = 3,
            tripId = 6,
            gear = Gear.PARK,
            parkedAtMillis = 0,
            firstDeparturePending = false,
        )
        val store = MemoryTripStore(stored).apply { failWrites = true }
        val detector = TripDetector(FakeClock(900_000), store)

        assertFalse(detector.onBoot(4))
        assertFalse(detector.onGear(Gear.DRIVE))
        assertEquals(stored, detector.snapshot)
    }

    @Test
    fun dialogTerminalIsCommittedWithoutChangingTripFields() {
        val (detector, _, store) = detector()
        assertTrue(detector.onBoot(21))
        val before = detector.snapshot

        assertTrue(detector.setDialogTerminal("DEFERRED"))

        assertEquals("DEFERRED", detector.snapshot.dialogTerminal)
        assertEquals(before.copy(dialogTerminal = "DEFERRED"), store.load())
    }

    private fun departedBoot(): Pair<TripDetector, FakeClock> {
        val (detector, clock, _) = detector()
        assertTrue(detector.onBoot(1))
        assertFalse(detector.onGear(Gear.DRIVE))
        return detector to clock
    }

    private fun detector(): Triple<TripDetector, FakeClock, MemoryTripStore> {
        val clock = FakeClock()
        val store = MemoryTripStore()
        return Triple(TripDetector(clock, store), clock, store)
    }

    private class MemoryTripStore(initial: TripSnapshot? = null) : TripStore {
        private var saved = initial
        var failWrites = false

        override fun load(): TripSnapshot? = saved

        override fun save(snapshot: TripSnapshot): Boolean {
            if (failWrites) return false
            saved = snapshot
            return true
        }
    }
}
