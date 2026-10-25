package dev.mobi.ui

import android.view.View
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.mobi.MobiViewState
import dev.mobi.dialog.DialogState
import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobiUiTest {
    @Test
    fun briefingStateInitializesAllCardsWithoutACardAcceptClick() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                val accepted = MobiViewState(
                    vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    state = DialogState.BRIEFING,
                    tripId = -21L,
                    demo = true,
                )
                fun title() = ((screen.findViewById<View>(dev.mobi.R.id.cards) as android.widget.LinearLayout)
                    .getChildAt(0) as TextView).text.toString()
                screen.render(accepted)
                DemoData.briefings.forEachIndexed { index, briefing ->
                    assertTrue("Accepted state must show card ${index + 1}", title().contains(briefing.name))
                    assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.next).visibility)
                    screen.render(accepted)
                    assertTrue("Repeated delivery must preserve progress", title().contains(briefing.name))
                    screen.findViewById<View>(dev.mobi.R.id.next).performClick()
                }
                assertEquals("브리핑이 끝났어요", title())
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.next).visibility)
                screen.render(accepted)
                assertEquals("Completion must survive repeated accepted state", "브리핑이 끝났어요", title())
                screen.render(accepted.copy(tripId = -22L))
                assertTrue("New demo starts at the first card", title().contains("하늘"))
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.next).visibility)
            }
        }
    }

    @Test
    fun unsafeSnapshotHidesCardsAndStaleClickCannotDispatch() {
        val actions = mutableListOf<Pair<String, Long>>()
        lateinit var screen: MobiScreen
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { action, trip -> actions += action to trip }
                activity.setContentView(screen)
                screen.render(
                    MobiViewState(
                        vehicle = VehicleSnapshot(Gear.DRIVE, uxKnown = true, restricted = false, available = true, sourceTimestampNanos = 101L),
                        state = DialogState.AWAITING_RESPONSE,
                        tripId = 42L,
                    ),
                )
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()

            scenario.onActivity {
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.cards).visibility)
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.accept).visibility)
                assertNotNull(screen.lastHiddenDrawMarker)
                assertEquals(101L, screen.lastHiddenDrawMarker?.first)
                assertTrue((screen.lastHiddenDrawMarker?.second ?: 0L) >= 101L)

                screen.findViewById<View>(dev.mobi.R.id.accept).performClick()
                assertTrue(actions.isEmpty())

                screen.render(
                    MobiViewState(
                        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                        state = DialogState.AWAITING_RESPONSE,
                        tripId = 42L,
                    ),
                )
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.cards).visibility)
                screen.findViewById<View>(dev.mobi.R.id.accept).performClick()
                assertEquals(listOf("accept" to 42L), actions)

                screen.render(
                    MobiViewState(
                        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                        state = DialogState.DEFERRED,
                        tripId = 42L,
                        demo = true,
                    ),
                )
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.cards).visibility)
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.accept).visibility)
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.decline).visibility)
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.demo).visibility)
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.live).visibility)
                screen.findViewById<View>(dev.mobi.R.id.accept).performClick()
                screen.findViewById<View>(dev.mobi.R.id.decline).performClick()
                assertEquals(listOf("accept" to 42L), actions)

                screen.render(
                    MobiViewState(
                        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                        state = DialogState.MUTED,
                        tripId = 42L,
                        demo = true,
                    ),
                )
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.accept).visibility)
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.demo).visibility)
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.live).visibility)

                screen.render(
                    MobiViewState(
                        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                        state = DialogState.BRIEFING,
                        tripId = 42L,
                        demo = false,
                    ),
                )
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.cards).visibility)
                assertEquals("정차 중 계정을 연결해 주세요", (screen.findViewById<View>(dev.mobi.R.id.cards) as android.widget.LinearLayout)
                    .getChildAt(0).let { (it as TextView).text })
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.demo).visibility)
                assertEquals(View.VISIBLE, screen.findViewById<View>(dev.mobi.R.id.live).visibility)

                screen.render(
                    MobiViewState(
                        vehicle = VehicleSnapshot(Gear.DRIVE, uxKnown = true, restricted = false, available = true, sourceTimestampNanos = 202L),
                        state = DialogState.AWAITING_RESPONSE,
                        tripId = 42L,
                    ),
                )
                screen.findViewById<View>(dev.mobi.R.id.accept).performClick()
                assertEquals(listOf("accept" to 42L), actions)
            }
        }
    }
    @Test fun qrAndEveryNewActionAreHiddenForUnsafeSnapshotsAndStaleClicks() {
        val actions=mutableListOf<String>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario -> scenario.onActivity { activity ->
            val screen=MobiScreen(activity){action,_->actions+=action};activity.setContentView(screen)
            val safe=MobiViewState(vehicle=VehicleSnapshot(Gear.PARK,uxKnown=true,restricted=false,available=true),pairing=PairingView("pending","https://example.test/pair/fixture"))
            screen.render(safe)
            assertEquals(View.VISIBLE,screen.findViewById<View>(dev.mobi.R.id.pairing_qr).visibility)
            for(gear in listOf(Gear.DRIVE,Gear.REVERSE,Gear.NEUTRAL,Gear.UNKNOWN)) {
                screen.render(safe.copy(vehicle=safe.vehicle.copy(gear=gear)))
                for(id in listOf(dev.mobi.R.id.pairing_qr,dev.mobi.R.id.connect,dev.mobi.R.id.speak)) assertEquals(View.GONE,screen.findViewById<View>(id).visibility)
                screen.findViewById<View>(dev.mobi.R.id.connect).performClick()
            }
            screen.render(safe.copy(vehicle=safe.vehicle.copy(restricted=true)))
            assertEquals(View.GONE,screen.findViewById<View>(dev.mobi.R.id.pairing_qr).visibility)
            assertTrue(actions.isEmpty())
        } }
    }
    @Test fun expiredConnectionCanBePairedAgainEvenWhileTodayCacheExists() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario -> scenario.onActivity { activity ->
            val screen=MobiScreen(activity){_,_->};activity.setContentView(screen)
            val audio=dev.mobi.net.WavAudio("fixture")
            val spoken=dev.mobi.net.KnockAudio("fixture",audio,"0".repeat(64))
            val today=dev.mobi.net.TodayResponse("2026-10-24","Asia/Seoul",emptyList(),dev.mobi.net.KnockBundle("knock-v1","2026-10-24","Asia/Seoul",0,spoken,spoken))
            screen.render(MobiViewState(vehicle=VehicleSnapshot(Gear.PARK,uxKnown=true,restricted=false,available=true),micReady=true,today=today,needsConnection=true))
            assertEquals(View.VISIBLE,screen.findViewById<View>(dev.mobi.R.id.connect).visibility)
            assertEquals(View.GONE,screen.findViewById<View>(dev.mobi.R.id.speak).visibility)
        } }
    }

    @Test
    fun drivingCancelsParkedMotionBeforeTheNextFrame() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                val safe = MobiViewState(
                    vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    demo = true,
                )
                screen.render(safe)
                screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE))
                val content = screen.getChildAt(0)
                if (android.animation.ValueAnimator.areAnimatorsEnabled()) {
                    assertTrue("Exercise an in-flight parked entry", content.alpha < 1f)
                } else {
                    assertEquals(1f, content.alpha, 0f)
                    assertEquals(0f, content.translationY, 0f)
                }
                screen.render(safe.copy(vehicle = safe.vehicle.copy(gear = Gear.DRIVE)))
                assertEquals("Unsafe render is opaque immediately", 1f, content.alpha, 0f)
                assertEquals("Unsafe render cannot retain entry movement", 0f, content.translationY, 0f)
                for (id in listOf(dev.mobi.R.id.accept, dev.mobi.R.id.decline, dev.mobi.R.id.demo,
                    dev.mobi.R.id.live, dev.mobi.R.id.next, dev.mobi.R.id.connect, dev.mobi.R.id.speak)) {
                    val control = screen.findViewById<View>(id)
                    assertEquals(View.GONE, control.visibility)
                    assertEquals(1f, control.scaleX, 0f)
                    assertEquals(1f, control.scaleY, 0f)
                }
            }
        }
    }

    @Test
    fun segmentPagerRetainsAccessibleProgressWithoutNumericText() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                val safe = MobiViewState(
                    vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    state = DialogState.BRIEFING, demo = true,
                )
                fun descendants(view: View): List<View> = listOf(view) +
                    if (view is android.view.ViewGroup) (0 until view.childCount).flatMap {
                        descendants(view.getChildAt(it))
                    } else emptyList()
                screen.render(safe)
                assertTrue(descendants(screen).any { it.contentDescription == "1 / 3" })
                assertTrue(descendants(screen).filterIsInstance<TextView>().none { it.text == "1 / 3" })
                screen.findViewById<View>(dev.mobi.R.id.next).performClick()
                assertTrue(descendants(screen).any { it.contentDescription == "2 / 3" })
                if (!android.animation.ValueAnimator.areAnimatorsEnabled()) {
                    assertTrue("Reduced motion stays fully opaque and still", descendants(screen).all {
                        it.alpha == 1f && it.translationY == 0f && it.scaleX == 1f && it.scaleY == 1f
                    })
                }
            }
        }
    }


    @Test
    fun touchPressFeedbackRespectsSystemMotionAndStopsOnDrive() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val expected = InstrumentationRegistry.getArguments().getString("expectedAnimators")
        if (expected != null) {
            assertEquals("Exercise the requested system motion preference", expected.toBoolean(),
                android.animation.ValueAnimator.areAnimatorsEnabled())
        }
        lateinit var screen: MobiScreen
        lateinit var control: View
        val safe = MobiViewState(
            vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
            state = DialogState.BRIEFING, demo = true,
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                screen.render(safe)
                control = screen.findViewById(dev.mobi.R.id.next)
            }
            instrumentation.waitForIdleSync()
            val location = IntArray(2)
            var ready = false
            for (attempt in 0 until 30) {
                scenario.onActivity {
                    ready = control.isLaidOut && control.width > 0 && control.height > 0 && control.hasWindowFocus()
                    control.getLocationOnScreen(location)
                }
                if (ready) break
                Thread.sleep(50)
            }
            assertTrue("Touch target must be laid out and focused before injection", ready)
            android.util.Log.i("MobiDesign", "PRESS_TARGET x=${location[0]} y=${location[1]} w=${control.width} h=${control.height} display=${control.display.displayId}")
            val downTime = android.os.SystemClock.uptimeMillis()
            fun pointer(action: Int) {
                val event = android.view.MotionEvent.obtain(downTime, android.os.SystemClock.uptimeMillis(),
                    action, location[0] + control.width / 2f, location[1] + control.height / 2f, 0)
                instrumentation.sendPointerSync(event)
                event.recycle()
            }
            pointer(android.view.MotionEvent.ACTION_DOWN)
            Thread.sleep(180)
            scenario.onActivity {
                val scale = if (android.animation.ValueAnimator.areAnimatorsEnabled()) 0.97f else 1f
                assertEquals("Touch-down feedback follows motion preference", scale, control.scaleX, 0.001f)
                assertEquals(scale, control.scaleY, 0.001f)
                screen.render(safe.copy(vehicle = safe.vehicle.copy(gear = Gear.DRIVE)))
                assertEquals("Drive resets a pressed button immediately", 1f, control.scaleX, 0f)
                assertEquals(View.GONE, control.visibility)
            }
            pointer(android.view.MotionEvent.ACTION_CANCEL)
        }
    }

}
