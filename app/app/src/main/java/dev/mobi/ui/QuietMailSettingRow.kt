package dev.mobi.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.StateListDrawable
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Checkable
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import com.google.android.material.materialswitch.MaterialSwitch
import dev.mobi.R

/** One car-sized, accessible switch target; the trailing widget shares its state. */
class QuietMailSettingRow(context: Context) : LinearLayout(context), Checkable {
    private lateinit var control: MaterialSwitch
    private var binding = false
    private var onToggle: ((Boolean) -> Unit)? = null

    init {
        id = R.id.quiet_mail_setting
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = pixels(R.dimen.quiet_setting_min_height)
        val padding = pixels(R.dimen.quiet_setting_padding)
        setPaddingRelative(padding, padding, padding, padding)
        isFocusable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = context.getString(R.string.quiet_mail_setting)
        fun fill() = GradientDrawable().apply {
            setColor(context.getColor(R.color.pleos_surface))
            setStroke(pixels(R.dimen.pleos_button_stroke_width), context.getColor(R.color.pleos_divider))
            cornerRadius = resources.getDimension(R.dimen.pleos_surface_radius)
        }
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), LayerDrawable(arrayOf(fill(),
                ColorDrawable(context.getColor(R.color.pleos_secondary_pressed)))))
            addState(intArrayOf(), fill())
        }
        val labels = LinearLayout(context).apply {
            orientation = VERTICAL
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        fun label(id: Int, text: Int, size: Int, color: Int) = TextView(context).apply {
            this.id = id
            setText(text)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, resources.getDimension(size))
            setTextColor(context.getColor(color))
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            includeFontPadding = false
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            setLineHeight((textSize * 1.4f).toInt())
        }
        labels.addView(label(R.id.quiet_mail_label, R.string.quiet_mail_setting,
            R.dimen.quiet_setting_label_size, R.color.pleos_text), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        labels.addView(label(R.id.quiet_mail_description, R.string.quiet_mail_setting_description,
            R.dimen.quiet_setting_description_size, R.color.pleos_secondary),
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = pixels(R.dimen.quiet_setting_description_gap)
            })
        addView(labels, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        // Scope the Material theme to this widget; keep the rest of the app theme.
        control = MaterialSwitch(ContextThemeWrapper(context, R.style.QuietMailSwitchTheme)).apply {
            id = R.id.quiet_mail_switch
            text = null
            showText = false
            isFocusable = false
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            minimumWidth = pixels(R.dimen.quiet_setting_switch_width)
            minimumHeight = pixels(R.dimen.quiet_setting_switch_height)
            setPadding(0, 0, 0, 0)
            thumbTintList = colors(Color.WHITE, context.getColor(R.color.pleos_secondary))
            trackTintList = colors(context.getColor(R.color.pleos_active), context.getColor(R.color.pleos_surface))
            trackDecorationTintList = colors(Color.TRANSPARENT, context.getColor(R.color.pleos_secondary))
            setOnCheckedChangeListener { _, checked ->
                updateStateDescription()
                if (!binding) onToggle?.invoke(checked)
            }
        }
        addView(control, LayoutParams(pixels(R.dimen.quiet_setting_switch_width),
            pixels(R.dimen.quiet_setting_switch_height)).apply {
                marginStart = pixels(R.dimen.quiet_setting_switch_gap)
            })
        setOnClickListener { toggle() }
        updateStateDescription()
    }

    fun setOnToggleListener(listener: (Boolean) -> Unit) { onToggle = listener }
    override fun isChecked(): Boolean = ::control.isInitialized && control.isChecked
    override fun setChecked(checked: Boolean) {
        binding = true
        try { control.isChecked = checked } finally { binding = false }
        updateStateDescription()
    }
    override fun toggle() { control.toggle() }
    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        if (::control.isInitialized) control.isEnabled = enabled
    }
    override fun getAccessibilityClassName(): CharSequence = Switch::class.java.name
    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.isCheckable = true
        info.isChecked = isChecked()
    }
    override fun onInitializeAccessibilityEvent(event: AccessibilityEvent) {
        super.onInitializeAccessibilityEvent(event)
        event.isChecked = isChecked()
    }
    private fun updateStateDescription() {
        stateDescription = context.getString(if (isChecked()) R.string.quiet_mail_on else R.string.quiet_mail_off)
    }
    private fun pixels(id: Int) = resources.getDimensionPixelSize(id)
    private fun colors(checked: Int, unchecked: Int) = ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(checked, unchecked))
}
