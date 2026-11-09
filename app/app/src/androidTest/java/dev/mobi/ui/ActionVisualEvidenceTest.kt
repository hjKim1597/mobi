package dev.mobi.ui

import android.content.res.Configuration
import android.graphics.Bitmap
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.mobi.MobiViewState
import dev.mobi.dialog.ActionView
import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Opt-in screenshot fixture. Run once in day mode and once in night mode. */
@RunWith(AndroidJUnit4::class)
class ActionVisualEvidenceTest {
    @Test fun captureActionStatesAndDrivingPrivacy() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("captureActionEvidence") == "true")
        val mode = args.getString("mode") ?: "day"
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.filesDir, "actions")
        check(directory.mkdirs() || directory.isDirectory)
        val parked = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true)
        val mail = ActionView("offer", "mail_reply", "회의 시간 확인", "가상 담당자 · 11월 10일 오후 두 시 회의가 가능한지 확인해 주세요.", true, true)
        val approval = ActionView("approval", "mail_reply", "가상 회신", DemoActions.replyReadback, readbackFinished = true)
        val holding = ActionView("holding", "mail_reply", "가상 회신", DemoActions.holdReply, readbackFinished = true)
        val result = ActionView("result", "mail_reply", "처리 결과", "회신을 보냈어요.")
        val demo = ActionView("offer", "mail_reply", DemoActions.mailTitle, DemoActions.mailDetail, true, true, demo = true)
        val fixture = MobiViewState(vehicle = parked)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var screen: MobiScreen
            scenario.onActivity { activity ->
                assertEquals(mode == "night", activity.resources.configuration.uiMode and
                    Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
            }
            fun capture(name: String, value: MobiViewState) {
                scenario.onActivity { screen.render(value) }
                Thread.sleep(400)
                instrumentation.waitForIdleSync()
                scenario.onActivity {
                    val card = screen.findViewById<android.widget.LinearLayout>(dev.mobi.R.id.cards)
                    if (card.visibility == View.VISIBLE) {
                        for (index in 0..1) {
                            val child = card.getChildAt(index)
                            val visible = android.graphics.Rect()
                            org.junit.Assert.assertTrue("Action text must be visible", child.getGlobalVisibleRect(visible))
                            org.junit.Assert.assertEquals("Action text must not be clipped",child.height,visible.height())
                        }
                    }
                }
                val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                File(directory, "$mode-$name.png").outputStream().use {
                    check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
                bitmap.recycle()
            }
            Thread.sleep(300)
            capture("mail", fixture.copy(action = mail))
            capture("approval", fixture.copy(action = approval))
            capture("holding", fixture.copy(action = holding))
            capture("result", fixture.copy(action = result))
            capture("quiet-setting", fixture.copy(action = result, quietMail = true))
            capture("demo", fixture.copy(action = demo, demo = true))
            capture("calendar-approval", fixture.copy(action = ActionView("approval", "calendar_insert", "일정 내용 확인", DemoActions.calendarReadback, readbackFinished = true)))
            capture("driving", fixture.copy(vehicle = parked.copy(gear = Gear.DRIVE, restricted = true), action = mail))
            scenario.onActivity {
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.cards).visibility)
                assertEquals(View.GONE, screen.findViewById<View>(dev.mobi.R.id.action_reply).visibility)
            }
        }
    }
}
