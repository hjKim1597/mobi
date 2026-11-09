package dev.mobi.voice

import android.content.Context
import dev.mobi.R
import dev.mobi.net.WavAudio
import java.util.Base64

/** Fixed, local demo/failure speech. Personal action audio never enters this store. */
class ActionAudioAssets(private val context: Context) {
    fun get(name: String): WavAudio? {
        val id = RESOURCES[name] ?: return null
        val bytes = context.resources.openRawResource(id).use { it.readBytes() }
        return try { WavAudio(Base64.getEncoder().encodeToString(bytes)) } finally { bytes.fill(0) }
    }
    companion object {
        private val RESOURCES = mapOf(
            "unknown" to R.raw.action_unknown,
            "unknown_calendar" to R.raw.action_unknown_calendar,
            "unknown_generic" to R.raw.action_unknown_generic,
            "not_written_reply" to R.raw.action_not_written_reply,
            "not_written_calendar" to R.raw.action_not_written_calendar,
            "failed_reply" to R.raw.action_failed_reply,
            "failed_calendar" to R.raw.action_failed_calendar,
            "demo_mail" to R.raw.action_demo_mail,
            "demo_prompt" to R.raw.action_demo_prompt,
            "demo_reply" to R.raw.action_demo_reply,
            "demo_calendar" to R.raw.action_demo_calendar,
            "demo_calendar_offer" to R.raw.action_demo_calendar_offer,
            "demo_hold_reply" to R.raw.action_demo_hold_reply,
            "demo_hold_calendar" to R.raw.action_demo_hold_calendar,
            "demo_reply_result" to R.raw.action_demo_reply_result,
            "demo_calendar_result" to R.raw.action_demo_calendar_result,
        )
        val NAMES = RESOURCES.keys
    }
}
