package dev.mobi.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

class AudioFocus(context: Context, private val pauseImmediately: () -> Unit, private val changed: (Boolean) -> Unit, private val lost: () -> Unit = {}) : AutoCloseable {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    @Volatile var navigationActive = false; private set
    @Volatile private var held = false
    @Volatile private var closed = false
    private val focusListener = AudioManager.OnAudioFocusChangeListener { value ->
        if (closed) return@OnAudioFocusChangeListener
        if (value != AudioManager.AUDIOFOCUS_GAIN) { held = false; pauseImmediately(); lost() }
        else { held = true; changed(refresh()) }
    }
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener(focusListener, handler).build()
    private val callback = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) { update(configs) }
    }
    init { manager.registerAudioPlaybackCallback(callback, handler); refresh() }
    private fun update(configs: List<AudioPlaybackConfiguration>): Boolean {
        if (closed) return true
        val active = configs.any { it.audioAttributes.usage == AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE }
        if (active) pauseImmediately()
        if (navigationActive != active) {
            navigationActive = active
            Log.i("Mobi", "NAV_ACTIVE active=$active atMs=${SystemClock.elapsedRealtime()}")
            changed(active)
        }
        return active
    }
    fun refresh(): Boolean = runCatching { update(manager.activePlaybackConfigurations) }.getOrElse { pauseImmediately(); true }
    fun acquire(): Boolean {
        if (closed || refresh()) return false
        if (held) return true
        held = manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        return held && !refresh()
    }
    fun release() {
        if (held) manager.abandonAudioFocusRequest(request)
        held = false
    }
    override fun close() {
        if (closed) return
        closed = true; manager.unregisterAudioPlaybackCallback(callback)
        manager.abandonAudioFocusRequest(request); held = false
    }
}
