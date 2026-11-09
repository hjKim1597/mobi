package dev.mobi.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.view.View
import android.view.ViewGroup
import android.view.animation.AnimationUtils
import dev.mobi.R

/** Keeps outgoing pixels only; stale controls are removed from the live view tree immediately. */
internal class ContentFade(private val host: ViewGroup, private val content: View) {
    private val curve = AnimationUtils.loadInterpolator(host.context, android.R.interpolator.decelerate_cubic)
    private var enter: ValueAnimator? = null
    private var exit: ValueAnimator? = null
    private var outgoing: BitmapDrawable? = null

    fun capture(): BitmapDrawable? {
        if (content.width == 0 || content.height == 0) return null
        val bitmap = Bitmap.createBitmap(content.width, content.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        // Preserve the composited presentation on retarget: a transparent snapshot would
        // reveal new/overlapping text immediately beneath its partially transparent pixels.
        canvas.drawColor(host.context.getColor(R.color.pleos_surface))
        val layer = canvas.saveLayerAlpha(0f, 0f, bitmap.width.toFloat(), bitmap.height.toFloat(),
            (content.alpha * 255).toInt())
        content.draw(canvas)
        canvas.restoreToCount(layer)
        outgoing?.draw(canvas)
        return BitmapDrawable(host.resources, bitmap).apply {
            setBounds(content.left, content.top, content.right, content.bottom)
        }
    }

    fun start(previous: BitmapDrawable?) {
        val startAlpha = if (enter?.isRunning == true) content.alpha else 0f
        enter?.cancel()
        exit?.cancel()
        content.alpha = startAlpha
        enter = ValueAnimator.ofFloat(startAlpha, 1f).apply {
            duration = host.resources.getInteger(R.integer.pleos_content_enter_ms).toLong()
            interpolator = curve
            addUpdateListener { content.alpha = it.animatedValue as Float }
            start()
        }
        if (previous != null) {
            outgoing = previous
            host.overlay.add(previous)
            exit = ValueAnimator.ofInt(255, 0).apply {
                duration = host.resources.getInteger(R.integer.pleos_content_exit_ms).toLong()
                interpolator = curve
                addUpdateListener { previous.alpha = it.animatedValue as Int }
                addListener(object : AnimatorListenerAdapter() {
                    override fun onAnimationEnd(animation: Animator) {
                        host.overlay.remove(previous)
                        previous.bitmap.recycle()
                        if (outgoing === previous) {
                            outgoing = null
                            exit = null
                        }
                    }
                })
                start()
            }
        }
    }

    fun reset() {
        enter?.cancel()
        exit?.cancel()
        enter = null
        exit = null
        outgoing?.let {
            host.overlay.remove(it)
            if (!it.bitmap.isRecycled) it.bitmap.recycle()
        }
        outgoing = null
        content.alpha = 1f
        content.translationY = 0f
    }
}
