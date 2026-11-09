package dev.mobi.ui

import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewTreeObserver
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.mobi.MobiViewState
import dev.mobi.R
import dev.mobi.dialog.DialogState
import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Opt-in native-view fixtures for the requested screenshots and frame measurement. */
@RunWith(AndroidJUnit4::class)
class MobiVisualEvidenceTest {
    @Test fun captureStatesAndMotion() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("captureEvidence") == "true")
        val mode = args.getString("mode") ?: "day"
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.filesDir, "pleos-motion-evidence")
        check(directory.mkdirs() || directory.isDirectory)
        val safe = MobiViewState(
            vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
            demo = true,
        )
        lateinit var screen: MobiScreen
        var changeAt = 0L
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertEquals(mode == "night", activity.resources.configuration.uiMode and
                    Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
                screen = MobiScreen(activity) { action, _ ->
                    if (action == "demo") {
                        changeAt = SystemClock.uptimeMillis()
                        screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE))
                        Log.i("MobiMotionEvidence", "CONTENT_CHANGE uptimeMs=$changeAt")
                    }
                }
                activity.setContentView(screen)
                screen.render(safe)
                screen.viewTreeObserver.addOnDrawListener {
                    if (changeAt != 0L && SystemClock.uptimeMillis() - changeAt < 500) {
                        Log.i("MobiMotionEvidence", "CONTENT_DRAW uptimeMs=${SystemClock.uptimeMillis()} alpha=${screen.getChildAt(0).alpha}")
                    }
                }
                val heading = screen.findViewById<TextView>(R.id.status)
                assertEquals(500, heading.typeface.weight)
                File(directory, "$mode-metrics.txt").writeText(
                    "headingTypefaceWeight=${heading.typeface.weight}\n" +
                        "surface=${activity.getColor(R.color.pleos_surface).toUInt().toString(16)}\n" +
                        "text=${heading.currentTextColor.toUInt().toString(16)}\n")
            }
            var ready = false
            repeat(50) {
                scenario.onActivity { ready = screen.isLaidOut && screen.width > 0 && screen.hasWindowFocus() }
                val activeRoot = instrumentation.uiAutomation.rootInActiveWindow
                ready = ready && activeRoot?.packageName == instrumentation.targetContext.packageName
                activeRoot?.recycle()
                if (!ready) Thread.sleep(50)
            }
            assertTrue("Fixture window must be visible before capture", ready)
            fun capture(name: String) {
                Thread.sleep(400)
                instrumentation.waitForIdleSync()
                val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                File(directory, "$mode-$name.png").outputStream().use {
                    check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
                bitmap.recycle()
            }
            capture("parked-idle")
            if (args.getString("captureMotion") == "true") {
                lateinit var control: View
                val xy = IntArray(2)
                var downAt = 0L
                var firstPressedDraw = false
                scenario.onActivity {
                    control = screen.findViewById(R.id.demo)
                    control.getLocationOnScreen(xy)
                    control.viewTreeObserver.addOnDrawListener(object : ViewTreeObserver.OnDrawListener {
                        override fun onDraw() {
                            if (control.isPressed && !firstPressedDraw) {
                                firstPressedDraw = true
                                Log.i("MobiMotionEvidence", "PRESS_DRAW inputMs=$downAt drawMs=${SystemClock.uptimeMillis()} scale=${control.scaleX}")
                            }
                        }
                    })
                }
                Thread.sleep(1000)
                downAt = SystemClock.uptimeMillis()
                fun pointer(action: Int) {
                    val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action,
                        xy[0] + control.width / 2f, xy[1] + control.height / 2f, 0)
                    instrumentation.sendPointerSync(event)
                    event.recycle()
                }
                pointer(MotionEvent.ACTION_DOWN)
                Thread.sleep(300)
                pointer(MotionEvent.ACTION_UP)
                Thread.sleep(500)
                assertTrue("The down state must be drawn before release", firstPressedDraw)
            }
            if (args.getString("capturePressed") == "true") {
                scenario.onActivity { screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE)) }
                Thread.sleep(350)
                for ((id, name) in listOf(R.id.accept to "primary-pressed", R.id.decline to "secondary-pressed")) {
                    lateinit var button: View
                    val xy = IntArray(2)
                    scenario.onActivity {
                        button = screen.findViewById(id)
                        button.getLocationOnScreen(xy)
                    }
                    val down = SystemClock.uptimeMillis()
                    fun pointer(action: Int) {
                        val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action,
                            xy[0] + button.width / 2f, xy[1] + button.height / 2f, 0)
                        instrumentation.sendPointerSync(event)
                        event.recycle()
                    }
                    pointer(MotionEvent.ACTION_DOWN)
                    capture(name)
                    scenario.onActivity {
                        assertTrue("Pressed capture must contain the actual down state", button.isPressed)
                        assertEquals(1f, button.scaleX, 0f)
                    }
                    pointer(MotionEvent.ACTION_CANCEL)
                }
            }
            scenario.onActivity { screen.render(safe.copy(state = DialogState.BRIEFING)) }
            capture("briefing-card")
            scenario.onActivity {
                repeat(3) { screen.findViewById<View>(R.id.next).performClick() }
                val title = (screen.findViewById<LinearLayout>(R.id.cards).getChildAt(0) as TextView).text
                assertEquals("브리핑이 끝났어요", title)
            }
            capture("completion")
            scenario.onActivity { screen.render(safe.copy(vehicle = safe.vehicle.copy(gear = Gear.DRIVE))) }
            capture("driving")
        }
    }
}
