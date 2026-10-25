package dev.mobi.dialog

import dev.mobi.voice.Intent
import org.junit.Assert.*
import org.junit.Test

class DialogStateMachineTest {
    @Test fun knockAcceptAndDeclineAreTripScoped() {
        val machine = DialogStateMachine()
        machine.startTrip(10, 100)
        val generation = machine.generation
        assertEquals(DialogState.KNOCKING, machine.state)
        machine.knockFinished(10, generation, 200)
        assertEquals(DialogState.AWAITING_RESPONSE, machine.state)
        machine.respond(10, Intent.ACCEPT)
        assertEquals(DialogState.BRIEFING, machine.state)
        machine.respond(10, Intent.DECLINE)
        assertEquals(DialogState.MUTED, machine.state)
        assertTrue(machine.muted)
        machine.startTrip(11, 300)
        assertFalse(machine.muted)
    }

    @Test fun timeoutAtSixSecondsDefersWithoutMuting() {
        val machine = DialogStateMachine()
        machine.startTrip(1, 0)
        machine.knockFinished(1, machine.generation, 100)
        machine.tick(6_099)
        assertEquals(DialogState.AWAITING_RESPONSE, machine.state)
        machine.tick(6_100)
        assertEquals(DialogState.DEFERRED, machine.state)
        assertFalse(machine.muted)
    }

    @Test fun ambiguousAndActionIntentsDoNotCauseExternalAction() {
        val machine = DialogStateMachine()
        machine.startTrip(2, 0)
        machine.knockFinished(2, machine.generation, 0)
        machine.onFinalSentence(2, "아마")
        assertEquals(DialogState.DEFERRED, machine.state)
        assertFalse(machine.muted)

        machine.startTrip(3, 0)
        machine.knockFinished(3, machine.generation, 0)
        machine.respond(3, Intent.SEND)
        assertEquals(DialogState.AWAITING_RESPONSE, machine.state)
    }

    @Test fun cancelClosesFlowAndStaleEventsAreIgnored() {
        val machine = DialogStateMachine()
        machine.startTrip(4, 0)
        val staleGeneration = machine.generation
        machine.startTrip(5, 10)
        machine.knockFinished(4, staleGeneration, 20)
        machine.respond(4, Intent.ACCEPT)
        assertEquals(DialogState.KNOCKING, machine.state)
        machine.knockFinished(5, machine.generation, 20)
        machine.respond(5, Intent.CANCEL)
        assertEquals(DialogState.DEFERRED, machine.state)
    }

    @Test fun drivingBeforeMicReadyDefersAndReturningToParkDoesNotRestart() {
        val machine = DialogStateMachine()
        machine.startTrip(6, 0)
        machine.knockFinished(6, machine.generation, 0)
        machine.onDriving(micReady = false)
        assertEquals(DialogState.DEFERRED, machine.state)
        machine.onDriving(micReady = false)
        assertEquals(DialogState.DEFERRED, machine.state)
    }

    @Test fun restorePreservesMuteForSameTrip() {
        val machine = DialogStateMachine()
        machine.restore(7, muted = true)
        assertEquals(7L, machine.tripId)
        assertEquals(DialogState.MUTED, machine.state)
        assertTrue(machine.muted)
    }

    @Test fun restorePreservesStableTerminalStates() {
        val machine = DialogStateMachine()
        machine.restore(8, muted = false, terminal = "DEFERRED")
        assertEquals(DialogState.DEFERRED, machine.state)
        machine.restore(9, muted = false, terminal = "BRIEFING")
        assertEquals(DialogState.BRIEFING, machine.state)
    }

    @Test fun restoreNeverRevivesConsumedResponseOrUnknownTerminal() {
        val machine = DialogStateMachine()
        machine.restore(10, muted = false, terminal = "AWAITING_RESPONSE")
        assertEquals(DialogState.DEFERRED, machine.state)
        machine.respond(10, Intent.ACCEPT)
        assertEquals(DialogState.DEFERRED, machine.state)

        machine.restore(13, muted = false, terminal = "KNOCKING")
        assertEquals(DialogState.DEFERRED, machine.state)

        machine.restore(11, muted = false, terminal = "future-state")
        assertEquals(DialogState.DEFERRED, machine.state)
    }

    @Test fun persistedMuteOverridesTerminal() {
        val machine = DialogStateMachine()
        machine.restore(12, muted = true, terminal = "BRIEFING")
        assertEquals(DialogState.MUTED, machine.state)
        assertTrue(machine.muted)
    }
    @Test fun voiceStartSuspendsOnlyTheResponseWindowAndStaleGenerationCannotDefer() {
        val m=DialogStateMachine();m.startTrip(1,0);val old=m.generation
        m.knockFinished(1,old,0);m.voiceStarted(1,old);m.tick(6000)
        assertEquals(DialogState.AWAITING_RESPONSE,m.state)
        m.startTrip(1,7000);m.defer(1,old);assertEquals(DialogState.KNOCKING,m.state)
        m.defer(1,m.generation);assertEquals(DialogState.DEFERRED,m.state)
    }
}
