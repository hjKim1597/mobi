package dev.mobi.voice

import android.content.Context
import android.util.Base64
import dev.mobi.R
import dev.mobi.net.WavAudio

/** Loads the two pre-generated, fixed failure recordings once per service runtime. */
class FailureAudioAssets(context: Context) {
    private val resources = context.applicationContext.resources
    private val confirm = load(R.raw.confirm_failure)
    private val question = load(R.raw.question_failure)

    fun forMode(mode: CaptureMode): WavAudio? = if (mode == CaptureMode.CONFIRM) confirm else question

    private fun load(resourceId: Int): WavAudio? = runCatching {
        val bytes = resources.openRawResource(resourceId).use { it.readBytes() }
        try {
            val audio = WavAudio(Base64.encodeToString(bytes, Base64.NO_WRAP))
            audio.bytes().fill(0)
            audio
        } finally { bytes.fill(0) }
    }.getOrNull()
}
