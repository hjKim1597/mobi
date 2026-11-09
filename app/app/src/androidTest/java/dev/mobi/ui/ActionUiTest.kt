package dev.mobi.ui

import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mobi.MobiViewState
import dev.mobi.R
import dev.mobi.dialog.ActionView
import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ActionUiTest {
    private fun parked(action: ActionView) = MobiViewState(
        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
        action = action,
    )

    @Test fun approvalButtonWaitsForFinishedReadbackAndHoldingOffersOnlyCancel() {
        val actions = mutableListOf<String>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var screen: MobiScreen
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { name, _ -> actions += name }
                activity.setContentView(screen)
                screen.render(parked(ActionView("approval", "mail_reply", "가상 회신", "본문", demo = true)))
            }
            scenario.onActivity {
                val approve = screen.findViewById<View>(R.id.action_approve)
                assertFalse(approve.isEnabled)
                approve.performClick()
                assertTrue(actions.isEmpty())
                screen.render(parked(ActionView("approval", "mail_reply", "가상 회신", "본문", readbackFinished = true, demo = true)))
                assertTrue(approve.isEnabled)
                approve.performClick()
                assertEquals(listOf("action_approve"), actions)
                screen.render(parked(ActionView("holding", "mail_reply", "가상 회신", "보류", readbackFinished = true, demo = true)))
                assertEquals(View.GONE, screen.findViewById<View>(R.id.action_approve).visibility)
                assertEquals(View.VISIBLE, screen.findViewById<View>(R.id.action_cancel).visibility)
                assertEquals(View.GONE, screen.findViewById<View>(R.id.action_reply).visibility)
                for (id in listOf(R.id.demo,R.id.live,R.id.connect,R.id.speak,R.id.next)) {
                    assertEquals("Holding exposes only cancellation",View.GONE,screen.findViewById<View>(id).visibility)
                }
                screen.findViewById<View>(R.id.action_cancel).performClick()
                assertEquals("action_cancel", actions.last())
            }
        }
    }

    @Test fun offerButtonsMatchCapabilitiesAndRecheckStageAtClickTime() {
        val actions = mutableListOf<String>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var screen: MobiScreen
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { name, _ -> actions += name }
                activity.setContentView(screen)
                screen.render(parked(ActionView("offer", "mail_reply", "가상 메일", "요약", canReply = true)))
            }
            scenario.onActivity {
                val reply = screen.findViewById<View>(R.id.action_reply)
                val calendar = screen.findViewById<View>(R.id.action_calendar)
                assertEquals(View.VISIBLE, reply.visibility)
                assertEquals(View.GONE, calendar.visibility)
                screen.render(parked(ActionView("result", "mail_reply", "완료", "결과")))
                reply.performClick()
                assertTrue("A stale offer button must be rejected after the stage changes", actions.isEmpty())
            }
        }
    }

    @Test fun leavingParkedHidesAndClearsActionContentImmediately() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var screen: MobiScreen
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                screen.render(parked(ActionView("offer", "mail_reply", "이름 민감한 제목", "개인 메일 내용", canReply = true)))
                screen.render(parked(ActionView("offer", "mail_reply", "이름 민감한 제목", "개인 메일 내용", canReply = true)).copy(
                    vehicle = VehicleSnapshot(Gear.DRIVE, uxKnown = true, restricted = true, available = true)))
                assertEquals(View.GONE, screen.findViewById<View>(R.id.cards).visibility)
                assertEquals(View.GONE, screen.findViewById<View>(R.id.action_reply).visibility)
                val titles = screen.findViewsByText("이름 민감한 제목")
                assertTrue("Personal action text must be absent from the view hierarchy", titles.isEmpty())
            }
        }
    }

    private fun MobiScreen.findViewsByText(value: String): List<View> {
        val matches = mutableListOf<View>()
        fun walk(view: View) {
            if (view is android.widget.TextView && view.text.toString() == value) matches += view
            if (view is android.view.ViewGroup) for (index in 0 until view.childCount) walk(view.getChildAt(index))
        }
        walk(this)
        return matches
    }
}
