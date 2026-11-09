package dev.mobi.ui

import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.mobi.MobiViewState
import dev.mobi.dialog.DialogState
import dev.mobi.dialog.ActionView
import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobiUiTest {
    @Test
    fun quietMailSettingIsParkedOnlyAndStaleDrivingClickCannotChangeIt() {
        val actions = mutableListOf<Pair<String, Long>>()
        lateinit var screen: MobiScreen
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { action, trip -> actions += action to trip }
                activity.setContentView(screen)
                screen.render(MobiViewState(
                    vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    tripId = 7L,
                ))
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.onActivity {
                val setting = screen.findViewById<QuietMailSettingRow>(dev.mobi.R.id.quiet_mail_setting)
                assertEquals(View.VISIBLE, setting.visibility)
                assertTrue(setting.minimumHeight >= (76 * it.resources.displayMetrics.density).toInt())
                assertFalse(setting.isChecked)
                setting.performClick()
                assertEquals(listOf("quiet_mail_set|true" to 7L), actions)
                assertTrue(setting.isChecked)

                screen.render(MobiViewState(
                    vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    tripId = 7L,
                    quietMail = true,
                ))
                setting.performClick()
                assertEquals(listOf("quiet_mail_set|true" to 7L, "quiet_mail_set|false" to 7L), actions)
                assertFalse(setting.isChecked)

                screen.render(MobiViewState(
                    vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    tripId = 7L,
                    voicePhase = "SPEAKING",
                    action = ActionView("result", "mail_reply", "처리 결과", "메일 요약"),
                ))
                assertTrue("Preference edits are disabled during active action speech", !setting.isEnabled)
                setting.performClick()
                assertEquals(2, actions.size)

                screen.render(MobiViewState(
                    vehicle = VehicleSnapshot(Gear.DRIVE, uxKnown = true, restricted = false, available = true),
                    tripId = 7L,
                    quietMail = true,
                ))
                assertEquals(View.GONE, setting.visibility)
                setting.performClick()
                assertEquals("A stale click while driving is ignored", 2, actions.size)
            }
        }
    }

    @Test
    fun quietMailSettingUsesCompactPaddingAtPhoneWidths() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                for (widthDp in listOf(320, 360)) {
                    val widthPx = (widthDp * activity.resources.displayMetrics.density).toInt()
                    val heightPx = (800 * activity.resources.displayMetrics.density).toInt()
                    val screen = MobiScreen(activity) { _, _ -> }
                    screen.render(MobiViewState(
                        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                        tripId = widthDp.toLong(),
                    ))
                    screen.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY))
                    screen.layout(0, 0, widthPx, heightPx)
                    val setting = screen.findViewById<QuietMailSettingRow>(dev.mobi.R.id.quiet_mail_setting)
                    val label = setting.findViewById<TextView>(dev.mobi.R.id.quiet_mail_label)
                    val description = setting.findViewById<TextView>(dev.mobi.R.id.quiet_mail_description)
                    val control = setting.findViewById<View>(dev.mobi.R.id.quiet_mail_switch)
                    assertEquals(View.VISIBLE, setting.visibility)
                    assertTrue("$widthDp dp setting width=${setting.width}", setting.width >= widthPx * 3 / 4)
                    assertEquals("메일 내용 읽지 않기", label.text.toString())
                    assertEquals("운전 중에는 메일이 왔다는 것만 알려드려요.", description.text.toString())
                    assertEquals(android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP,
                        32f, activity.resources.displayMetrics), label.textSize, 0.1f)
                    assertEquals(android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP,
                        24f, activity.resources.displayMetrics), description.textSize, 0.1f)
                    assertTrue(control.width >= (64 * activity.resources.displayMetrics.density).toInt())
                    assertTrue(control.height >= (48 * activity.resources.displayMetrics.density).toInt())
                }
            }
        }
    }

    @Test
    fun quietMailSettingHasStableThemeGeometryAndOneNamedSwitchAccessibilityNode() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val dimensions = mutableListOf<List<Int>>()
                for (night in listOf(false, true)) {
                    val config = android.content.res.Configuration(activity.resources.configuration).apply {
                        uiMode = (uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK.inv()) or
                            if (night) android.content.res.Configuration.UI_MODE_NIGHT_YES else android.content.res.Configuration.UI_MODE_NIGHT_NO
                    }
                    val themed = android.view.ContextThemeWrapper(activity.createConfigurationContext(config), dev.mobi.R.style.AppTheme)
                    val screen = MobiScreen(themed) { _, _ -> }
                    screen.render(MobiViewState(
                        vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                        tripId = if (night) 2L else 1L,
                        quietMail = night,
                        action = ActionView("offer", "mail_reply", "회의 시간 확인", "확인할까요?", true, true),
                    ))
                    val density = themed.resources.displayMetrics.density
                    val width = (2560 * density).toInt()
                    val height = (1440 * density).toInt()
                    screen.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
                    screen.layout(0, 0, width, height)

                    val setting = screen.findViewById<QuietMailSettingRow>(dev.mobi.R.id.quiet_mail_setting)
                    val label = setting.findViewById<TextView>(dev.mobi.R.id.quiet_mail_label)
                    val description = setting.findViewById<TextView>(dev.mobi.R.id.quiet_mail_description)
                    val control = setting.findViewById<View>(dev.mobi.R.id.quiet_mail_switch)
                    dimensions.add(listOf(setting.width, setting.height, label.width, label.height,
                        description.width, description.height, control.width, control.height))

                    val cards = screen.findViewById<View>(dev.mobi.R.id.cards)
                    val actionButtons = listOf(dev.mobi.R.id.action_reply, dev.mobi.R.id.action_calendar,
                        dev.mobi.R.id.action_approve, dev.mobi.R.id.action_cancel, dev.mobi.R.id.action_decline)
                        .map { screen.findViewById<View>(it) }.filter { it.visibility == View.VISIBLE }
                    fun screenTop(view: View): Int = android.graphics.Rect().let { rect ->
                        screen.offsetDescendantRectToMyCoords(view, rect)
                        rect.top
                    }
                    assertTrue("The setting follows the main result card",
                        screenTop(setting) > screenTop(cards) + cards.height)
                    assertTrue("The setting follows action controls", screenTop(setting) >
                        actionButtons.maxOf { screenTop(it) + it.height })

                    assertEquals("com.google.android.material.materialswitch.MaterialSwitch", control.javaClass.name)
                    assertEquals("메일 내용 읽지 않기", setting.contentDescription.toString())
                    assertTrue(setting.isFocusable)
                    assertFalse(label.isFocusable)
                    assertFalse(description.isFocusable)
                    assertTrue(label.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO ||
                        label.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS)
                    assertTrue(description.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO ||
                        description.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS)
                    val node = setting.createAccessibilityNodeInfo()
                    assertEquals("android.widget.Switch", node.className.toString())
                    assertTrue(node.isCheckable)
                    assertEquals(night, node.isChecked)
                }
                assertEquals("Day and night use identical setting geometry", dimensions[0], dimensions[1])
            }
        }
    }

    @Test
    fun unchangedBriefingPublicationDoesNotCaptureContent() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var screen: MobiScreen
        val safe = MobiViewState(
            vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
            state = DialogState.BRIEFING, demo = true,
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                screen.render(safe)
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                var snapshotDraws = 0
                val content = screen.getChildAt(0) as LinearLayout
                content.addView(object : View(activity) {
                    override fun onDraw(canvas: android.graphics.Canvas) { snapshotDraws++ }
                }, LinearLayout.LayoutParams(1, 1))
                screen.measure(View.MeasureSpec.makeMeasureSpec(screen.width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(screen.height, View.MeasureSpec.EXACTLY))
                screen.layout(0, 0, screen.width, screen.height)
                val before = snapshotDraws
                repeat(5) {
                    screen.render(safe.copy(vehicle = safe.vehicle.copy(sourceTimestampNanos = 100L + it)))
                }
                assertEquals("Unchanged presentation must not draw into a snapshot", before, snapshotDraws)
                screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE))
                if (android.animation.ValueAnimator.areAnimatorsEnabled()) {
                    assertTrue("A real transition exercises the snapshot probe", snapshotDraws > before)
                }
            }
        }
    }

    @Test
    fun snapshotsAreRecycledAfterExitAndReset() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var screen: MobiScreen
        lateinit var fade: ContentFade
        lateinit var first: android.graphics.drawable.BitmapDrawable
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity {
                fade = ContentFade(screen, screen.getChildAt(0))
                first = checkNotNull(fade.capture())
                fade.start(first)
            }
            var released = false
            repeat(100) {
                if (!released) {
                    scenario.onActivity { released = first.bitmap.isRecycled }
                    if (!released) Thread.sleep(20)
                }
            }
            scenario.onActivity {
                assertTrue("Completed outgoing pixels release their ARGB storage", first.bitmap.isRecycled)
                val second = checkNotNull(fade.capture())
                fade.start(second)
                fade.reset()
                assertTrue("Reset releases outgoing pixels immediately", second.bitmap.isRecycled)
            }
        }
    }

    @Test
    fun buttonSelectorsMatchPleosLayersStrokesAndTextInBothModes() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario -> scenario.onActivity { activity ->
            for (night in listOf(false, true)) {
                val config = android.content.res.Configuration(activity.resources.configuration).apply {
                    uiMode = (uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK.inv()) or
                        if (night) android.content.res.Configuration.UI_MODE_NIGHT_YES else android.content.res.Configuration.UI_MODE_NIGHT_NO
                }
                val themed = android.view.ContextThemeWrapper(activity.createConfigurationContext(config), dev.mobi.R.style.AppTheme)
                val screen = MobiScreen(themed) { _, _ -> }
                screen.render(MobiViewState(vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
                    state = DialogState.AWAITING_RESPONSE, demo = true))
                fun fill(button: android.widget.Button, pressed: Boolean, x: Int = 50): Int {
                    button.isPressed = pressed
                    button.background.setBounds(0, 0, 100, 88)
                    val bitmap = android.graphics.Bitmap.createBitmap(100, 88, android.graphics.Bitmap.Config.ARGB_8888)
                    button.background.draw(android.graphics.Canvas(bitmap))
                    return bitmap.getPixel(x, 44).also { bitmap.recycle() }
                }
                val primary = screen.findViewById<android.widget.Button>(dev.mobi.R.id.accept)
                val secondary = screen.findViewById<android.widget.Button>(dev.mobi.R.id.decline)
                assertEquals(if (night) 0xffdddddd.toInt() else 0xff000000.toInt(), fill(primary, false))
                assertEquals(if (night) 0xff000000.toInt() else 0xffffffff.toInt(), primary.currentTextColor)
                assertEquals(if (night) 0xfff1f1f1.toInt() else 0xff000000.toInt(), fill(primary, true))
                assertEquals(if (night) 0xcc000000.toInt() else 0xccffffff.toInt(), primary.currentTextColor)
                assertEquals(if (night) 0xff3f3f3f.toInt() else 0xffffffff.toInt(), fill(secondary, false))
                assertEquals("Secondary default stroke is black in the unqualified XML", 0xff000000.toInt(), fill(secondary, false, 0))
                val insideStroke = themed.resources.getDimensionPixelSize(dev.mobi.R.dimen.pleos_button_stroke_width)
                assertEquals("The outline is only one dp wide", if (night) 0xff3f3f3f.toInt() else 0xffffffff.toInt(),
                    fill(secondary, false, insideStroke))
                assertEquals(if (night) 0xffc5c5c5.toInt() else 0xff333333.toInt(), secondary.currentTextColor)
                assertEquals(if (night) 0xff4e4e4e.toInt() else 0xffebebeb.toInt(), fill(secondary, true))
                assertEquals(if (night) 0xccc5c5c5.toInt() else 0xcc333333.toInt(), secondary.currentTextColor)
            }
        } }
    }

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
    fun drivingClearsDepartingPixelsFromLaidOutContent() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var screen: MobiScreen
        val safe = MobiViewState(
            vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
            demo = true,
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                screen.render(safe)
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                val w = screen.width
                val h = screen.height
                assertTrue(w > 0 && h > 0)
                screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE))
                val driving = safe.copy(vehicle = safe.vehicle.copy(gear = Gear.DRIVE))
                screen.render(driving)
                val fresh = MobiScreen(activity) { _, _ -> }.apply { render(driving) }
                fun pixels(view: View): android.graphics.Bitmap {
                    view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                    view.layout(0, 0, w, h)
                    return android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                        .also { view.draw(android.graphics.Canvas(it)) }
                }
                val interrupted = pixels(screen)
                val static = pixels(fresh)
                assertTrue("No outgoing parked pixels may remain in an unsafe frame", interrupted.sameAs(static))
                interrupted.recycle()
                static.recycle()
            }
        }
    }

    @Test
    fun animatorScaleZeroClearsAnAlreadyRunningFade() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val original = android.provider.Settings.Global.getString(instrumentation.targetContext.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE)
        val originallyEnabled = (original?.toFloatOrNull() ?: 1f) > 0f
        fun shell(command: String) {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes() }
        }
        lateinit var screen: MobiScreen
        val safe = MobiViewState(
            vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
            demo = true,
        )
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    screen = MobiScreen(activity) { _, _ -> }
                    activity.setContentView(screen)
                    screen.render(safe)
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity {
                    assertTrue(screen.width > 0 && screen.height > 0)
                    screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE))
                }
                shell("settings put global animator_duration_scale 0")
                repeat(100) { if (android.animation.ValueAnimator.areAnimatorsEnabled()) Thread.sleep(20) }
                assertTrue(!android.animation.ValueAnimator.areAnimatorsEnabled())
                scenario.onActivity { activity ->
                    screen.render(safe.copy(state = DialogState.BRIEFING))
                    assertEquals(1f, screen.getChildAt(0).alpha, 0f)
                    assertEquals(0f, screen.getChildAt(0).translationY, 0f)
                    val fresh = MobiScreen(activity) { _, _ -> }.apply {
                        render(safe.copy(state = DialogState.BRIEFING))
                    }
                    fun frame(view: View): android.graphics.Bitmap {
                        val w = screen.width
                        val h = screen.height
                        view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                        view.layout(0, 0, w, h)
                        return android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                            .also { view.draw(android.graphics.Canvas(it)) }
                    }
                    val stopped = frame(screen)
                    val static = frame(fresh)
                    assertTrue("Scale zero must remove outgoing pixels too", stopped.sameAs(static))
                    stopped.recycle()
                    static.recycle()
                }
                Thread.sleep(250)
                scenario.onActivity { assertEquals("Canceled effects cannot reappear", 1f, screen.getChildAt(0).alpha, 0f) }
            }
        } finally {
            ActivityScenario.launch(MainActivity::class.java).use {
                shell("settings put global animator_duration_scale ${original ?: "1.0"}")
                repeat(100) {
                    if (android.animation.ValueAnimator.areAnimatorsEnabled() != originallyEnabled) Thread.sleep(20)
                }
                if (original == null) shell("settings delete global animator_duration_scale")
                assertEquals(originallyEnabled, android.animation.ValueAnimator.areAnimatorsEnabled())
            }
        }
    }

    @Test
    fun contentChangesAreAlphaOnlyAndResumeTheirOnScreenAlpha() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val original = android.provider.Settings.Global.getString(instrumentation.targetContext.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE)
        // Before a window is attached, the process cache can still report the default scale.
        val originalScale = original?.toFloatOrNull() ?: 1f
        fun shell(command: String) {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes() }
        }
        lateinit var screen: MobiScreen
        val safe = MobiViewState(
            vehicle = VehicleSnapshot(Gear.PARK, uxKnown = true, restricted = false, available = true),
            demo = true,
        )
        try {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                screen.render(safe)
            }
            instrumentation.waitForIdleSync()
            if (originalScale > 0f) {
                // A live window is needed for the system animator-scale observer to be registered.
                shell("settings put global animator_duration_scale 5")
                repeat(100) { if (android.animation.ValueAnimator.getDurationScale() != 5f) Thread.sleep(20) }
                assertEquals(5f, android.animation.ValueAnimator.getDurationScale(), 0f)
            }
            scenario.onActivity {
                screen.render(safe.copy(state = DialogState.AWAITING_RESPONSE))
            }
            Thread.sleep(60)
            if (originalScale > 0f) {
                var sampled = false
                repeat(40) {
                    if (!sampled) {
                        scenario.onActivity { sampled = screen.getChildAt(0).alpha in 0.01f..0.98f }
                        if (!sampled) Thread.sleep(10)
                    }
                }
                assertTrue("A running midpoint must be sampled", sampled)
            }
            scenario.onActivity {
                val content = screen.getChildAt(0)
                assertEquals("Content changes never translate", 0f, content.translationY, 0f)
                if (android.animation.ValueAnimator.areAnimatorsEnabled()) {
                    val currentAlpha = content.alpha
                    assertTrue("Exercise a real, laid-out in-flight fade", currentAlpha > 0f && currentAlpha < 1f)
                    fun frame(): android.graphics.Bitmap {
                        screen.measure(View.MeasureSpec.makeMeasureSpec(screen.width, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(screen.height, View.MeasureSpec.EXACTLY))
                        screen.layout(0, 0, screen.width, screen.height)
                        return android.graphics.Bitmap.createBitmap(screen.width, screen.height,
                            android.graphics.Bitmap.Config.ARGB_8888).also { screen.draw(android.graphics.Canvas(it)) }
                    }
                    val before = frame()
                    screen.render(safe.copy(state = DialogState.BRIEFING))
                    assertEquals("Retarget from the current presentation alpha", currentAlpha, content.alpha, 0.001f)
                    val after = frame()
                    assertTrue("Retarget must preserve composited pixels, including overlapping text", before.sameAs(after))
                    before.recycle()
                    after.recycle()
                } else {
                    screen.render(safe.copy(state = DialogState.BRIEFING))
                    assertEquals("Disabled animators never hide content", 1f, content.alpha, 0f)
                }
                assertEquals(0f, content.translationY, 0f)
                screen.render(safe.copy(vehicle = safe.vehicle.copy(restricted = true)))
                assertEquals("Unsafe render immediately ends the fade", 1f, content.alpha, 0f)
                assertEquals(0f, content.translationY, 0f)
            }
        }
        } finally {
            // Keep a window attached while restoring: Android only observes scale changes with a live window.
            ActivityScenario.launch(MainActivity::class.java).use {
                shell("settings put global animator_duration_scale ${original ?: "1.0"}")
                repeat(100) { if (android.animation.ValueAnimator.getDurationScale() != originalScale) Thread.sleep(20) }
                if (original == null) shell("settings delete global animator_duration_scale")
                assertEquals(originalScale, android.animation.ValueAnimator.getDurationScale(), 0f)
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
            state = DialogState.AWAITING_RESPONSE, demo = true,
        )
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                screen = MobiScreen(activity) { _, _ -> }
                activity.setContentView(screen)
                screen.render(safe)
                control = screen.findViewById(dev.mobi.R.id.decline)
            }
            instrumentation.waitForIdleSync()
            val location = IntArray(2)
            var ready = false
            for (attempt in 0 until 60) {
                scenario.onActivity {
                    ready = control.isLaidOut && control.width > 0 && control.height > 0 && control.hasWindowFocus()
                    control.getLocationOnScreen(location)
                }
                val activeRoot = instrumentation.uiAutomation.rootInActiveWindow
                ready = ready && activeRoot?.packageName == instrumentation.targetContext.packageName
                activeRoot?.recycle()
                if (ready) break
                Thread.sleep(50)
            }
            assertTrue("Touch target must be laid out and focused before injection", ready)
            // The Pleos shell can keep the old task's touch region during its pane reveal.
            Thread.sleep(500)
            var unpressedPixel = 0
            scenario.onActivity {
                control.getLocationOnScreen(location)
                val bitmap = android.graphics.Bitmap.createBitmap(control.width, control.height,
                    android.graphics.Bitmap.Config.ARGB_8888)
                control.background.draw(android.graphics.Canvas(bitmap))
                unpressedPixel = bitmap.getPixel(control.width / 2, control.height / 2)
                bitmap.recycle()
            }
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
                assertEquals("Pleos press feedback never scales text or the target", 1f, control.scaleX, 0f)
                assertEquals(1f, control.scaleY, 0f)
                val bitmap = android.graphics.Bitmap.createBitmap(control.width, control.height,
                    android.graphics.Bitmap.Config.ARGB_8888)
                control.background.draw(android.graphics.Canvas(bitmap))
                assertTrue("Touch-down visibly highlights the button even with animator scale zero",
                    bitmap.getPixel(control.width / 2, control.height / 2) != unpressedPixel)
                bitmap.recycle()
                screen.render(safe.copy(vehicle = safe.vehicle.copy(gear = Gear.DRIVE)))
                assertEquals("Drive resets a pressed button immediately", 1f, control.scaleX, 0f)
                assertEquals(View.GONE, control.visibility)
            }
            pointer(android.view.MotionEvent.ACTION_CANCEL)
        }
    }

}
