package dev.mobi.ui

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.animation.PathInterpolator
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
    private val content = LinearLayout(context)
    private val textBlock = LinearLayout(context)
    private val eyebrow = TextView(context)
    private val eyebrowRow = LinearLayout(context)
    private val pager = LinearLayout(context)
    private val voiceMark = View(context)
    private val cardDivider = View(context)
    private val primaryActions = LinearLayout(context)
    private val modeActions = LinearLayout(context)
    private val cardDetail = TextView(context)
    private val acceptButton = button(R.string.accept, R.id.accept)
    private val declineButton = button(R.string.decline, R.id.decline)
    private val demoButton = button(R.string.demo, R.id.demo)
    private val liveButton = button(R.string.live, R.id.live)
    private val nextButton = button(R.string.next, R.id.next)
    private val connectButton = button(R.string.connect, R.id.connect)
    private val speakButton = button(R.string.speak, R.id.speak)
    private val qr = ImageView(context).apply { id = R.id.pairing_qr; visibility = GONE; contentDescription = "계정 연결 QR" }
    private val pairingStatus = TextView(context).apply { id = R.id.pairing_status; textSize = 24f; visibility = GONE }
    private val easeOut = PathInterpolator(0.23f, 1f, 0.32f, 1f)
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
            topMargin = dp(48)
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

    fun render(viewState: MobiViewState) {
        if (viewState.tripId != lastTripId || (viewState.demo && !lastDemo)) demoSession.reset()
        // Every accept entry point converges on BRIEFING. Initialize here rather
        // than in one button listener; accept() preserves active/completed progress.
        if (viewState.demo && viewState.state == DialogState.BRIEFING) demoSession.accept()
        lastTripId = viewState.tripId
        lastDemo = viewState.demo
        state = viewState
        drawGeneration++

        val vehicle = viewState.vehicle
        val interactive = isInteractive(viewState)
        // Unsafe visibility changes never wait for a transition or an animator frame.
        if (!interactive || !ValueAnimator.areAnimatorsEnabled()) resetMotion()
        status.text = when {
            !vehicle.available -> context.getString(R.string.status_unknown)
            interactive -> context.getString(R.string.status_parked)
            vehicle.restricted -> context.getString(R.string.status_restricted)
            vehicle.gear == Gear.DRIVE || vehicle.gear == Gear.REVERSE -> context.getString(R.string.status_driving)
            else -> context.getString(R.string.status_unknown)
        }
        if (interactive && !viewState.demo) {
            status.text = when (viewState.voicePhase) {
                "LISTENING" -> context.getString(R.string.listening)
                "THINKING" -> context.getString(R.string.thinking)
                else -> if (viewState.message.isNotEmpty() && viewState.message != context.getString(R.string.not_now)) viewState.message else status.text
            }
        }
        val showQr = interactive && !viewState.demo && viewState.pairing.url != null
        qr.visibility = if (showQr) VISIBLE else GONE
        if (showQr && qrUrl != viewState.pairing.url) {
            qrUrl = viewState.pairing.url
            runCatching { QrCode.bitmap(requireNotNull(qrUrl), dp(360)) }.onSuccess { qr.setImageBitmap(it) }
        } else if (!showQr) { qr.setImageDrawable(null); qrUrl = null }
        val pairingLabel = when (viewState.pairing.status) {
            "pending" -> R.string.pairing_pending
            "processing" -> R.string.pairing_processing
            "paired" -> R.string.pairing_paired
            "failed" -> R.string.pairing_failed
            "expired" -> R.string.pairing_expired
            "registering" -> R.string.pairing_registering
            else -> null
        }
        pairingStatus.visibility = if (interactive && !viewState.demo && pairingLabel != null &&
            viewState.pairing.status != "pending") VISIBLE else GONE
        pairingStatus.text = pairingLabel?.let { context.getString(it) }.orEmpty()

        val showResponse = interactive && viewState.state == DialogState.AWAITING_RESPONSE
        val showBriefing = interactive && viewState.state == DialogState.BRIEFING
        val showDemoBriefing = showBriefing && viewState.demo
        val showToday = interactive && !viewState.demo && viewState.today != null && !showQr
        cards.visibility = if (!showQr && (showResponse || showBriefing || showToday)) VISIBLE else GONE
        val complete = showDemoBriefing && demoSession.isComplete
        status.visibility = if (cards.visibility == VISIBLE) GONE else VISIBLE
        if (showQr) status.text = context.getString(R.string.pairing_title)
        status.contentDescription = status.text
        guidance.text = context.getString(when {
            !interactive -> R.string.driving_guidance
            showQr -> R.string.pairing_guidance
            else -> R.string.home_guidance
        })
        guidance.visibility = if (cards.visibility == VISIBLE) GONE else VISIBLE
        val textGravity = if (interactive) Gravity.START else Gravity.CENTER
        textBlock.gravity = if (interactive) Gravity.START else Gravity.CENTER_HORIZONTAL
        styleHeading(status, if (interactive) 64f else 52f)
        status.gravity = textGravity
        guidance.gravity = textGravity
        eyebrowRow.visibility = if (interactive) VISIBLE else GONE
        eyebrow.text = context.getString(when {
            showQr -> R.string.pairing_eyebrow
            complete -> R.string.complete_eyebrow
            viewState.demo && (showResponse || showDemoBriefing) -> R.string.demo_badge
            showToday || showBriefing -> R.string.today_subtitle
            else -> R.string.parked_eyebrow
        })
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
        if (showResponse) {
            cardTitle.text = context.getString(if (viewState.demo) R.string.demo_response_prompt else R.string.response_prompt)
            cardDetail.text = context.getString(if (viewState.demo) R.string.demo_guidance else R.string.response_guidance)
        } else if (showDemoBriefing) {
            val briefing = demoSession.current
            cardTitle.text = briefing?.let { "${it.name} · ${it.title}" } ?: context.getString(R.string.briefing_complete)
            cardDetail.text = briefing?.detail ?: context.getString(R.string.complete_guidance)
        } else if ((showBriefing || showToday) && !viewState.demo) {
            val today = viewState.today
            cardTitle.text = if (today == null) context.getString(R.string.connect_required) else context.getString(R.string.today_title, today.events.size)
            cardDetail.text = today?.events?.joinToString("\n") { event ->
                val time = if (event.allDay) context.getString(R.string.all_day) else runCatching {
                    OffsetDateTime.parse(event.start).atZoneSameInstant(ZoneId.of(today.timeZone)).format(DateTimeFormatter.ofPattern("HH:mm"))
                }.getOrDefault("")
                "$time · ${event.title}"
            }.orEmpty()
        }

        acceptButton.visibility = if (showResponse) VISIBLE else GONE
        declineButton.visibility = if (showResponse) VISIBLE else GONE
        nextButton.visibility = if (showDemoBriefing && demoSession.current != null && !demoSession.isComplete) VISIBLE else GONE
        val canChooseMode = interactive && viewState.state != DialogState.KNOCKING && viewState.state != DialogState.AWAITING_RESPONSE
        demoButton.visibility = if (canChooseMode && (!showDemoBriefing || complete)) VISIBLE else GONE
        liveButton.visibility = if (canChooseMode && !showQr && (!showDemoBriefing || complete)) VISIBLE else GONE
        connectButton.visibility = if (canChooseMode && !viewState.demo && !showQr && (viewState.today == null || viewState.needsConnection)) VISIBLE else GONE
        speakButton.visibility = if (canChooseMode && !viewState.demo && viewState.micReady && viewState.today != null && !viewState.needsConnection && viewState.voicePhase == "IDLE") VISIBLE else GONE
        modeActions.visibility = if ((0 until modeActions.childCount).any { modeActions.getChildAt(it).visibility == VISIBLE }) VISIBLE else GONE
        primaryActions.visibility = if ((0 until primaryActions.childCount).any { primaryActions.getChildAt(it).visibility == VISIBLE }) VISIBLE else GONE
        val key = listOf(
            interactive, status.text.toString(), eyebrow.text.toString(),
            if (cards.visibility == VISIBLE) cardTitle.text.toString() to cardDetail.text.toString() else null,
            showQr, pairingStatus.text.toString(), viewState.voicePhase,
            connectButton.visibility, speakButton.visibility, demoButton.visibility,
        )
        if (interactive && ValueAnimator.areAnimatorsEnabled() && presentationKey != null && key != presentationKey) {
            content.animate().cancel()
            content.alpha = 0f
            content.translationY = dp(8).toFloat()
            content.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(easeOut).start()
        }
        presentationKey = key
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
        content.animate().cancel()
        content.alpha = 1f
        content.translationY = 0f
        for (control in listOf(connectButton, speakButton, acceptButton, declineButton, nextButton, demoButton, liveButton)) {
            control.animate().cancel()
            control.scaleX = 1f
            control.scaleY = 1f
            (control.background as? RippleDrawable)?.jumpToCurrentState()
        }
    }

    override fun onDetachedFromWindow() {
        resetMotion()
        super.onDetachedFromWindow()
    }

    private fun surface(color: Int, outlined: Boolean = false) = GradientDrawable().apply {
        setColor(context.getColor(color))
        cornerRadius = dp(2).toFloat()
        if (outlined) setStroke(dp(1), context.getColor(R.color.pleos_divider))
    }

    private fun actionLayout() = LayoutParams(LayoutParams.WRAP_CONTENT, dp(88)).apply {
        marginEnd = dp(16)
    }

    private fun button(label: Int, viewId: Int): Button = object : Button(context) {
        override fun setPressed(pressed: Boolean) {
            super.setPressed(pressed)
            if (!isAttachedToWindow) return
            animate().cancel()
            if (isInTouchMode && isInteractive() && ValueAnimator.areAnimatorsEnabled()) {
                val scale = if (pressed) 0.97f else 1f
                animate().scaleX(scale).scaleY(scale).setDuration(120).setInterpolator(easeOut).start()
            } else {
                scaleX = 1f
                scaleY = 1f
            }
        }
    }.apply {
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
        setTextColor(context.getColor(if (primary) R.color.pleos_surface else R.color.pleos_text))
        background = RippleDrawable(
            ColorStateList.valueOf(context.getColor(R.color.pleos_ripple)),
            surface(if (primary) R.color.pleos_text else R.color.pleos_surface, outlined = !primary),
            null,
        )
        stateListAnimator = null
        elevation = 0f
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
