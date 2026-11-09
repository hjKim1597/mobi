package dev.mobi.dialog

import org.junit.Assert.*
import org.junit.Test

class ActionDialogTest {
    @Test fun offerIsConsumedOnceEvenAfterDeclineOrTimeout() {
        val d = ActionDialog(); d.begin(1, 2)
        assertTrue(d.claimOffer()); d.move(ActionStage.OFFER); d.move(ActionStage.RESULT)
        assertFalse(d.claimOffer())
        d.begin(1, 3); assertFalse(d.claimOffer())
        d.begin(2, 1); assertTrue(d.claimOffer())
    }
    @Test fun oldTripGenerationSerialAndActionCallbacksAreRejected() {
        val d = ActionDialog(); d.begin(1, 1); val empty = d.token()
        d.bind("one", 1); assertFalse(d.current(empty))
        val one = d.token(); d.bind("one", 2); assertFalse(d.current(one))
        val two = d.token(); d.bind("two", 1); assertFalse(d.current(two))
        val old = d.token(); d.move(ActionStage.READBACK); assertFalse(d.current(old))
        val oldGeneration = d.token(); d.begin(1, 2); assertFalse(d.current(oldGeneration))
        val oldTrip = d.token(); d.begin(2, 2); assertFalse(d.current(oldTrip))
    }
    @Test fun readbackMustFinishBeforeApprovalAndApprovalIsNeverReused() {
        val d = ActionDialog(); d.begin(1, 1); d.bind("one", 1); d.move(ActionStage.READBACK)
        assertFalse(d.approve())
        d.readbackComplete(); assertTrue(d.approve()); assertFalse(d.approve())
        d.move(ActionStage.RESULT); assertFalse(d.approve())
    }
    @Test fun restartOnlyAllowsStatusAndNeverApproval() {
        val d = ActionDialog(); d.begin(1, 1); d.restore("one")
        assertEquals(ActionStage.PROCESSING, d.stage); assertFalse(d.approve())
        d.readbackComplete(); assertFalse(d.approve())
    }
    @Test fun unknownAndNotApprovedAreTerminalAndCannotApprove() {
        val d = ActionDialog(); d.begin(1, 1); d.bind("one", 1)
        for (stage in listOf(ActionStage.UNKNOWN, ActionStage.RESULT, ActionStage.CANCELLING, ActionStage.HOLDING)) {
            d.move(stage); assertFalse(d.approve())
        }
    }
    @Test fun nextCalendarActionCanBeApprovedButSameActionCannotBeRearmed() {
        val d=ActionDialog(); d.begin(1,1); d.bind("reply",1); d.move(ActionStage.READBACK)
        d.readbackComplete(); assertTrue(d.approve()); d.move(ActionStage.RESULT)
        d.bind("calendar",1); d.move(ActionStage.READBACK); d.readbackComplete()
        assertTrue(d.approve())
        d.bind("calendar",1); d.move(ActionStage.READBACK); d.readbackComplete()
        assertFalse(d.approve())
    }
}
