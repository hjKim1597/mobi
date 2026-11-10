package dev.mobi.ui

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ImageView
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import dev.mobi.R
import dev.mobi.MobiViewState
import dev.mobi.dialog.DialogState
import dev.mobi.dialog.SafetyGate
import dev.mobi.vehicle.Gear

/** Small native view tree. All interactive controls are gated again at click time. */
class MobiScreen(
    context: Context,
    private val onAction: (String, Long) -> Unit,
) : LinearLayout(context) {
    private val status = TextView(context)
    private val cards = LinearLayout(context).apply {
        id = R.id.cards
        orientation = VERTICAL
        visibility = GONE
    }
    private val cardTitle = TextView(context)
    private val guidance = TextView(context)
    private val quietMailToggle = QuietMailSettingRow(context)
    private val content = LinearLayout(context)
    private val contentFade = ContentFade(this, content)
    private val textBlock = LinearLayout(context)
    private val eyebrow = TextView(context)
    private val eyebrowRow = LinearLayout(context)
    private val pager = LinearLayout(context)
    private val voiceMark = View(context)
    private val cardDivider = View(context)
    private val primaryActions = LinearLayout(context)
    private val modeActions = LinearLayout(context)
    private val actionActions = LinearLayout(context)
    private val cardDetail = TextView(context)
    private val acceptButton = button(R.string.accept, R.id.accept)
    private val declineButton = button(R.string.decline, R.id.decline)
    private val demoButton = button(R.string.demo, R.id.demo)
    private val liveButton = button(R.string.live, R.id.live)
    private val nextButton = button(R.string.next, R.id.next)
    private val connectButton = button(R.string.connect, R.id.connect)
    private val speakButton = button(R.string.speak, R.id.speak)
    private val actionReplyButton = button(R.string.action_reply, R.id.action_reply)
    private val actionCalendarButton = button(R.string.action_calendar, R.id.action_calendar)
    private val actionApproveButton = button(R.string.action_approve_reply, R.id.action_approve)
    private val actionCancelButton = button(R.string.action_cancel, R.id.action_cancel)
    private val actionDeclineButton = button(R.string.action_decline, R.id.action_decline)
    private val demoMailButton = button(R.string.action_demo_mail, R.id.action_demo_mail)
    private val demoVoiceButton = button(R.string.action_demo_voice, R.id.action_demo_voice)
    private val demoDictateButton = button(R.string.action_demo_dictate, R.id.action_demo_dictate)
    private val demoClarifyButton = button(R.string.action_demo_clarify, R.id.action_demo_clarify)
    private val actionButtons = listOf(actionReplyButton, actionCalendarButton, actionApproveButton,
        actionCancelButton, actionDeclineButton, demoMailButton, demoVoiceButton, demoDictateButton, demoClarifyButton)
    private val qr = ImageView(context).apply { id = R.id.pairing_qr; visibility = GONE; contentDescription = "계정 연결 QR" }
    private val pairingStatus = TextView(context).apply { id = R.id.pairing_status; textSize = 24f; visibility = GONE }
    private var presentationKey: List<Any?>? = null
    private var qrUrl: String? = null
    private val demoSession = DemoSession()
    private var state: MobiViewState? = null
    private var lastDemo = false
    private var lastTripId = Long.MIN_VALUE
    private var drawGeneration = 0L
    private var loggedGeneration = -1L
    internal var lastHiddenDrawMarker: Pair<Long, Long>? = null
        private set

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setBackgroundColor(context.getColor(R.color.pleos_surface))

        content.orientation = HORIZONTAL
        content.gravity = Gravity.CENTER_VERTICAL
        content.setPadding(dp(96), dp(72), dp(96), dp(72))
        addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        textBlock.orientation = VERTICAL
        textBlock.gravity = Gravity.START
        content.addView(textBlock, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        content.addView(qr, LayoutParams(dp(360), dp(360)).apply { marginStart = dp(96) })

        voiceMark.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        textBlock.addView(voiceMark, LayoutParams(dp(20), dp(20)).apply { bottomMargin = dp(32) })
        styleText(eyebrow, 24f, secondary = true)
        eyebrowRow.gravity = Gravity.CENTER_VERTICAL
        eyebrowRow.addView(eyebrow)
        pager.gravity = Gravity.CENTER_VERTICAL
        pager.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        repeat(DemoData.briefings.size) {
            pager.addView(View(context).apply {
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LayoutParams(dp(8), dp(6)).apply { marginEnd = dp(8) })
        }
        eyebrowRow.addView(pager, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            marginStart = dp(28)
        })
        textBlock.addView(eyebrowRow, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = dp(28)
        })

        status.id = R.id.status
        styleHeading(status, 64f)
        status.contentDescription = context.getString(R.string.status_unknown)
        textBlock.addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        styleText(guidance, 32f, secondary = true)
        textBlock.addView(guidance, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(28)
        })

        styleHeading(cardTitle, 48f)
        styleText(cardDetail, 32f, secondary = true)
        cards.addView(cardTitle, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        cards.addView(cardDetail, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(28)
        })
        cardDivider.setBackgroundColor(context.getColor(R.color.pleos_divider))
        cards.addView(cardDivider, LayoutParams(LayoutParams.MATCH_PARENT, dp(1)).apply {
            topMargin = dp(44)
        })
        textBlock.addView(cards, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        actionActions.gravity = Gravity.START or Gravity.CENTER_VERTICAL
        actionButtons.forEach { actionActions.addView(it, actionLayout()) }
        textBlock.addView(actionActions, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(32)
        })
        styleText(pairingStatus, 24f, secondary = true)
        textBlock.addView(pairingStatus, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(24)
        })

        primaryActions.gravity = Gravity.START or Gravity.CENTER_VERTICAL
        modeActions.gravity = Gravity.START or Gravity.CENTER_VERTICAL
        for (control in listOf(connectButton, speakButton, acceptButton, declineButton, nextButton)) {
            primaryActions.addView(control, actionLayout())
        }
        for (control in listOf(demoButton, liveButton)) modeActions.addView(control, actionLayout())
        primaryActions.addView(modeActions)
        textBlock.addView(primaryActions, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(80)
        })
        textBlock.addView(quietMailToggle, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = resources.getDimensionPixelSize(R.dimen.quiet_setting_margin_top)
        })
        connectButton.setOnClickListener { state?.let { if (isInteractive() && !it.demo) onAction("connect", it.tripId) } }
        speakButton.setOnClickListener { state?.let { if (isInteractive() && !it.demo && it.micReady && it.voicePhase == "IDLE") onAction("speak", it.tripId) } }

        acceptButton.setOnClickListener {
            val current = state ?: return@setOnClickListener
            if (!isInteractive() || current.state != DialogState.AWAITING_RESPONSE) return@setOnClickListener
            onAction("accept", current.tripId)
        }
        declineButton.setOnClickListener {
            val current = state ?: return@setOnClickListener
            if (isInteractive() && current.state == DialogState.AWAITING_RESPONSE) {
                onAction("decline", current.tripId)
            }
        }
        nextButton.setOnClickListener {
            val current = state ?: return@setOnClickListener
            if (!isInteractive() || !current.demo || current.state != DialogState.BRIEFING || demoSession.isComplete || demoSession.current == null) return@setOnClickListener
            demoSession.next()
            onAction("next", current.tripId)
            render(current)
        }
        demoButton.setOnClickListener {
            val current = state ?: return@setOnClickListener
            if (isInteractive()) onAction("demo", current.tripId)
        }
        liveButton.setOnClickListener {
            val current = state ?: return@setOnClickListener
            if (isInteractive()) onAction("live", current.tripId)
        }
        actionReplyButton.setOnClickListener { sendAction("action_reply") }
        actionCalendarButton.setOnClickListener { sendAction("action_calendar") }
        actionApproveButton.setOnClickListener { sendAction("action_approve") }
        actionCancelButton.setOnClickListener { sendAction("action_cancel") }
        actionDeclineButton.setOnClickListener { sendAction("action_decline") }
        demoMailButton.setOnClickListener { sendAction("action_demo_mail") }
        demoVoiceButton.setOnClickListener { sendAction("action_demo_voice") }
        demoDictateButton.setOnClickListener { sendAction("action_demo_dictate") }
        demoClarifyButton.setOnClickListener { sendAction("action_demo_clarify") }
        quietMailToggle.setOnToggleListener { checked ->
            val current = state ?: return@setOnToggleListener
            if (!isInteractive(current) || current.demo || current.voicePhase != "IDLE" || current.action?.stage in
                setOf("processing", "offer", "dictation", "readback", "approval", "holding", "clarification")) {
                quietMailToggle.setChecked(current.quietMail)
                return@setOnToggleListener
            }
            onAction("quiet_mail_set|$checked", current.tripId)
        }

        viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                val current = state
                val generation = drawGeneration
                if (current != null && !isInteractive(current) && loggedGeneration != generation) {
                    loggedGeneration = generation
                    val drawNanos = SystemClock.elapsedRealtimeNanos()
                    lastHiddenDrawMarker = current.vehicle.sourceTimestampNanos to drawNanos
                    Log.i(
                        "Mobi",
                        "DRAW_HIDDEN sourceNs=${current.vehicle.sourceTimestampNanos} drawNs=$drawNanos",
                    )
                }
                return true
            }
        })
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val compact = width > 0 && width / resources.displayMetrics.density < 600f
        val horizontal = dp(if (compact) 24 else 96)
        val vertical = dp(if (compact) 24 else 72)
        if (content.paddingLeft != horizontal || content.paddingTop != vertical) {
            content.setPadding(horizontal, vertical, horizontal, vertical)
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    fun render(viewState: MobiViewState) {
        if (viewState.tripId != lastTripId || (viewState.demo && !lastDemo)) demoSession.reset()
        // Every accept entry point converges on BRIEFING. Initialize here rather
        // than in one button listener; accept() preserves active/completed progress.
        if (viewState.demo && viewState.state == DialogState.BRIEFING) demoSession.accept()
        lastTripId = viewState.tripId
        lastDemo = viewState.demo
        val next = presentation(viewState)
        val interactive = next.interactive
        // Decide from the actual presentation before any view mutation or ARGB allocation.
        val transition = interactive && ValueAnimator.areAnimatorsEnabled() &&
            presentationKey != null && next.key != presentationKey
        val previousPixels = if (transition) contentFade.capture() else null
        state = viewState
        drawGeneration++

        // Unsafe visibility changes never wait for a transition or an animator frame.
        if (!interactive || !ValueAnimator.areAnimatorsEnabled()) resetMotion()
        status.text = next.status
        val showQr = next.showQr
        qr.visibility = if (showQr) VISIBLE else GONE
        if (showQr && qrUrl != viewState.pairing.url) {
            qrUrl = viewState.pairing.url
            runCatching { QrCode.bitmap(requireNotNull(qrUrl), dp(360)) }.onSuccess { qr.setImageBitmap(it) }
        } else if (!showQr) { qr.setImageDrawable(null); qrUrl = null }
        val pairingLabel = next.pairingLabel
        pairingStatus.visibility = if (interactive && !viewState.demo && pairingLabel != null &&
            viewState.pairing.status != "pending") VISIBLE else GONE
        pairingStatus.text = next.pairingText

        val action = viewState.action.takeIf { interactive && !showQr }
        val showAction = action != null
        val showResponse = interactive && viewState.state == DialogState.AWAITING_RESPONSE
        val showBriefing = interactive && viewState.state == DialogState.BRIEFING
        val showDemoBriefing = showBriefing && viewState.demo
        val showToday = interactive && !viewState.demo && viewState.today != null && !showQr
        val showQuietMailSetting = interactive && !viewState.demo && !showQr
        cards.visibility = if (!showQr && (showResponse || showBriefing || showToday || showAction)) VISIBLE else GONE
        val complete = showDemoBriefing && demoSession.isComplete
        status.visibility = if (cards.visibility == VISIBLE) GONE else VISIBLE
        status.contentDescription = status.text
        guidance.text = context.getString(when {
            !interactive -> R.string.driving_guidance
            showQr -> R.string.pairing_guidance
            viewState.demo -> R.string.demo_home_guidance
            else -> R.string.home_guidance
        })
        guidance.visibility = if (cards.visibility == VISIBLE) GONE else VISIBLE
        quietMailToggle.visibility = if (showQuietMailSetting) VISIBLE else GONE
        quietMailToggle.isEnabled = showQuietMailSetting && viewState.voicePhase == "IDLE" && viewState.action?.stage !in
            setOf("processing", "offer", "dictation", "readback", "approval", "holding", "clarification")
        quietMailToggle.setChecked(viewState.quietMail)
        val textGravity = if (interactive) Gravity.START else Gravity.CENTER
        textBlock.gravity = if (interactive) Gravity.START else Gravity.CENTER_HORIZONTAL
        styleHeading(status, if (interactive) 64f else 52f)
        status.gravity = textGravity
        guidance.gravity = textGravity
        eyebrowRow.visibility = if (interactive) VISIBLE else GONE
        eyebrow.text = next.eyebrow
        val cardIndex = DemoData.briefings.indexOf(demoSession.current)
        pager.visibility = if (showDemoBriefing && !complete) VISIBLE else GONE
        pager.contentDescription = context.getString(R.string.briefing_progress, cardIndex + 1, DemoData.briefings.size)
        for (index in 0 until pager.childCount) {
            pager.getChildAt(index).apply {
                layoutParams = (layoutParams as LayoutParams).apply { width = dp(if (index == cardIndex) 36 else 8) }
                background = surface(if (index == cardIndex) R.color.pleos_active else R.color.pleos_divider)
            }
        }
        styleHeading(cardTitle, if (complete || showResponse) 60f else 48f)
        cardDivider.visibility = if (complete || showResponse) GONE else VISIBLE
        voiceMark.visibility = if (interactive) GONE else VISIBLE
        val voiceActive = viewState.voicePhase == "LISTENING" || viewState.voicePhase == "SPEAKING"
        voiceMark.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(context.getColor(if (voiceActive) R.color.pleos_active else R.color.pleos_secondary))
        }
        voiceMark.contentDescription = context.getString(when (viewState.voicePhase) {
            "LISTENING" -> R.string.listening
            "SPEAKING" -> R.string.speaking
            else -> R.string.voice_waiting
        })
        next.card?.let { (title, detail) -> cardTitle.text = title; cardDetail.text = detail }

        if (action != null) {
            cardTitle.text = action.title
            cardDetail.text = if (action.demo) "${action.detail}\n${context.getString(R.string.action_demo_badge)}" else action.detail
        } else if (!interactive || next.card == null) {
            cardTitle.text = ""
            cardDetail.text = ""
        }

        actionReplyButton.visibility = if (action?.let { it.stage == "offer" && it.canReply } == true) VISIBLE else GONE
        actionCalendarButton.visibility = if (action?.let { it.stage == "offer" && it.canAddCalendar } == true) VISIBLE else GONE
        actionApproveButton.visibility = if (action?.stage in setOf("readback", "approval")) VISIBLE else GONE
        actionApproveButton.text = context.getString(if (action?.kind == "calendar_insert") R.string.action_approve_calendar else R.string.action_approve_reply)
        actionApproveButton.isEnabled = action?.readbackFinished == true
        actionCancelButton.visibility = if (action?.stage in setOf("dictation", "readback", "approval", "holding", "clarification", "processing")) VISIBLE else GONE
        actionDeclineButton.visibility = if (action?.stage == "offer") VISIBLE else GONE
        demoMailButton.visibility = if (interactive && viewState.demo && complete && !showAction) VISIBLE else GONE
        demoVoiceButton.visibility = if (interactive && viewState.demo &&
            ((complete && !showAction) || action?.let { it.demo && it.stage == "result" } == true)) VISIBLE else GONE
        demoDictateButton.visibility = if (action?.let { it.demo && it.stage == "dictation" } == true) VISIBLE else GONE
        demoClarifyButton.visibility = if (action?.let { it.demo && it.stage == "clarification" } == true) VISIBLE else GONE
        actionActions.visibility = if (actionButtons.any { it.visibility == VISIBLE }) VISIBLE else GONE

        acceptButton.visibility = if (showResponse) VISIBLE else GONE
        declineButton.visibility = if (showResponse) VISIBLE else GONE
        nextButton.visibility = if (showDemoBriefing && demoSession.current != null && !demoSession.isComplete) VISIBLE else GONE
        val canChooseMode = interactive && viewState.state != DialogState.KNOCKING && viewState.state != DialogState.AWAITING_RESPONSE
        demoButton.visibility = if (next.demoVisible) VISIBLE else GONE
        liveButton.visibility = if (canChooseMode && !showQr && (!showDemoBriefing || complete)) VISIBLE else GONE
        connectButton.visibility = if (next.connectVisible) VISIBLE else GONE
        speakButton.visibility = if (next.speakVisible) VISIBLE else GONE
        if (showAction && action?.stage != "result") {
            listOf(acceptButton,declineButton,nextButton,demoButton,liveButton,connectButton,speakButton).forEach { it.visibility = GONE }
        }
        modeActions.visibility = if ((0 until modeActions.childCount).any { modeActions.getChildAt(it).visibility == VISIBLE }) VISIBLE else GONE
        primaryActions.visibility = if ((0 until primaryActions.childCount).any { primaryActions.getChildAt(it).visibility == VISIBLE }) VISIBLE else GONE
        if (transition) {
            if (ValueAnimator.areAnimatorsEnabled()) contentFade.start(previousPixels)
            else {
                previousPixels?.bitmap?.recycle()
                resetMotion()
            }
        }
        presentationKey = next.key
    }

    private fun sendAction(name: String) {
        val current = state ?: return
        val action = current.action
        if (!isInteractive(current)) return
        val allowed = when (name) {
            "action_reply" -> action?.let { it.stage == "offer" && it.canReply } == true
            "action_calendar" -> action?.let { it.stage == "offer" && it.canAddCalendar } == true
            "action_approve" -> action?.let { it.stage in setOf("readback", "approval") && it.readbackFinished } == true
            "action_cancel" -> action?.stage in setOf("dictation", "readback", "approval", "holding", "clarification", "processing")
            "action_decline" -> action?.stage == "offer"
            "action_demo_mail" -> current.demo && demoSession.isComplete && action == null
            "action_demo_voice" -> current.demo && ((demoSession.isComplete && action == null) ||
                action?.let { it.demo && it.stage == "result" } == true)
            "action_demo_dictate" -> action?.let { it.demo && it.stage == "dictation" } == true
            "action_demo_clarify" -> action?.let { it.demo && it.stage == "clarification" } == true
            else -> false
        }
        if (allowed) onAction(action?.identity?.let { "$name|$it" } ?: name, current.tripId)
    }

    private data class Presentation(
        val interactive: Boolean, val status: String, val eyebrow: String,
        val card: Pair<String, String>?, val showCards: Boolean, val showQr: Boolean,
        val pairingLabel: Int?, val pairingText: String, val voicePhase: String,
        val connectVisible: Boolean, val speakVisible: Boolean, val demoVisible: Boolean,
    ) {
        val key: List<Any?> = listOf(interactive, status, eyebrow, card.takeIf { showCards }, showQr,
            pairingText, voicePhase, connectVisible, speakVisible, demoVisible)
    }

    private fun presentation(value: MobiViewState): Presentation {
        val interactive = isInteractive(value)
        val showQr = interactive && !value.demo && value.pairing.url != null
        val response = interactive && value.state == DialogState.AWAITING_RESPONSE
        val briefing = interactive && value.state == DialogState.BRIEFING
        val demoBriefing = briefing && value.demo
        val today = interactive && !value.demo && value.today != null && !showQr
        val complete = demoBriefing && demoSession.isComplete
        var status = context.getString(when {
            !value.vehicle.available -> R.string.status_unknown
            interactive -> R.string.status_parked
            value.vehicle.restricted -> R.string.status_restricted
            value.vehicle.gear == Gear.DRIVE || value.vehicle.gear == Gear.REVERSE -> R.string.status_driving
            else -> R.string.status_unknown
        })
        if (interactive && !value.demo) status = when (value.voicePhase) {
            "LISTENING" -> context.getString(R.string.listening)
            "THINKING" -> context.getString(R.string.thinking)
            else -> value.message.takeIf { it.isNotEmpty() && it != context.getString(R.string.not_now) } ?: status
        }
        if (showQr) status = context.getString(R.string.pairing_title)
        val eyebrow = context.getString(when {
            showQr -> R.string.pairing_eyebrow
            complete -> R.string.complete_eyebrow
            value.demo && (response || demoBriefing) -> R.string.demo_badge
            today || briefing -> R.string.today_subtitle
            else -> R.string.parked_eyebrow
        })
        val card = when {
            response -> context.getString(if (value.demo) R.string.demo_response_prompt else R.string.response_prompt) to
                context.getString(if (value.demo) R.string.demo_guidance else R.string.response_guidance)
            demoBriefing -> (demoSession.current?.let { "${it.name} · ${it.title}" }
                ?: context.getString(R.string.briefing_complete)) to
                (demoSession.current?.detail ?: context.getString(R.string.complete_guidance))
            (briefing || today) && !value.demo -> {
                val data = value.today
                val title = if (data == null) context.getString(R.string.connect_required)
                    else context.getString(R.string.today_title, data.events.size)
                val detail = data?.events?.joinToString("\n") { event ->
                    val time = if (event.allDay) context.getString(R.string.all_day) else runCatching {
                        OffsetDateTime.parse(event.start).atZoneSameInstant(ZoneId.of(data.timeZone))
                            .format(DateTimeFormatter.ofPattern("HH:mm"))
                    }.getOrDefault("")
                    "$time · ${event.title}"
                }.orEmpty()
                title to detail
            }
            else -> null
        }
        val pairingLabel = when (value.pairing.status) {
            "pending" -> R.string.pairing_pending
            "processing" -> R.string.pairing_processing
            "paired" -> R.string.pairing_paired
            "failed" -> R.string.pairing_failed
            "expired" -> R.string.pairing_expired
            "registering" -> R.string.pairing_registering
            else -> null
        }
        val canChoose = interactive && value.state != DialogState.KNOCKING && value.state != DialogState.AWAITING_RESPONSE
        return Presentation(interactive, status, eyebrow, card, !showQr && (response || briefing || today), showQr,
            pairingLabel, pairingLabel?.let { context.getString(it) }.orEmpty(), value.voicePhase,
            canChoose && !value.demo && !showQr && (value.today == null || value.needsConnection),
            canChoose && !value.demo && value.micReady && value.today != null && !value.needsConnection && value.voicePhase == "IDLE",
            canChoose && (!demoBriefing || complete))
    }

    private fun isInteractive(): Boolean = state?.let(::isInteractive) ?: false

    private fun isInteractive(viewState: MobiViewState): Boolean =
        SafetyGate.interactive(viewState.vehicle)

    private fun styleText(view: TextView, size: Float, secondary: Boolean = false) {
        view.textSize = size
        view.setTextColor(context.getColor(if (secondary) R.color.pleos_secondary else R.color.pleos_text))
        view.includeFontPadding = false
        view.setLineSpacing(0f, 1f)
        view.setLineHeight((view.textSize * 1.4f).toInt())
    }

    private fun styleHeading(view: TextView, size: Float) {
        styleText(view, size)
        view.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        view.letterSpacing = -0.02f
        view.setLineHeight((view.textSize * 1.15f).toInt())
    }

    private fun resetMotion() {
        contentFade.reset()
        for (control in listOf(connectButton, speakButton, acceptButton, declineButton, nextButton, demoButton, liveButton)) {
            control.animate().cancel()
            control.scaleX = 1f
            control.scaleY = 1f
            control.isPressed = false
            control.background.jumpToCurrentState()
        }
        for (control in actionButtons) {
            control.animate().cancel()
            control.scaleX = 1f
            control.scaleY = 1f
            control.isPressed = false
            control.background.jumpToCurrentState()
        }
    }

    override fun onDetachedFromWindow() {
        resetMotion()
        super.onDetachedFromWindow()
    }

    private fun surface(color: Int, border: Int? = null) = GradientDrawable().apply {
        setColor(context.getColor(color))
        cornerRadius = resources.getDimension(R.dimen.pleos_surface_radius)
        if (border != null) setStroke(resources.getDimensionPixelSize(R.dimen.pleos_button_stroke_width), context.getColor(border))
    }

    private fun actionLayout() = LayoutParams(LayoutParams.WRAP_CONTENT, dp(88)).apply {
        marginEnd = dp(16)
    }

    private fun button(label: Int, viewId: Int): Button = Button(context).apply {
        id = viewId
        text = context.getString(label)
        isAllCaps = false
        textSize = 28f
        visibility = GONE
        minHeight = dp(88)
        minimumHeight = dp(88)
        minWidth = dp(200)
        minimumWidth = dp(200)
        setPadding(dp(32), 0, dp(32), 0)
        val primary = viewId in setOf(R.id.connect, R.id.accept, R.id.next, R.id.speak)
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled),
            intArrayOf(android.R.attr.state_pressed), intArrayOf()), intArrayOf(
            context.getColor(if (primary) R.color.pleos_primary_text_disabled else R.color.pleos_secondary_text_disabled),
            context.getColor(if (primary) R.color.pleos_primary_text_pressed else R.color.pleos_secondary_text_pressed),
            context.getColor(if (primary) R.color.pleos_primary_text else R.color.pleos_secondary_text))))
        val fill = if (primary) R.color.pleos_primary_fill else R.color.pleos_secondary_fill
        val normalBorder = if (primary) fill else R.color.pleos_secondary_border
        val pressed = if (primary) R.color.pleos_primary_pressed else R.color.pleos_secondary_pressed
        val disabled = if (primary) R.color.pleos_primary_disabled else R.color.pleos_secondary_disabled
        fun layered(border: Int, overlay: Int) = LayerDrawable(arrayOf(surface(fill, border),
            ColorDrawable(context.getColor(overlay))))
        backgroundTintList = null
        background = StateListDrawable().apply {
            setEnterFadeDuration(resources.getInteger(R.integer.pleos_press_enter_ms))
            setExitFadeDuration(resources.getInteger(R.integer.pleos_press_exit_ms))
            addState(intArrayOf(-android.R.attr.state_enabled),
                layered(if (primary) disabled else R.color.pleos_secondary_border_disabled, disabled))
            addState(intArrayOf(android.R.attr.state_pressed),
                layered(if (primary) pressed else R.color.pleos_secondary_border_pressed, pressed))
            addState(intArrayOf(), surface(fill, normalBorder))
        }
        stateListAnimator = null
        elevation = 0f
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
