package dev.mobi.voice

import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import dev.mobi.net.WavAudio

/** Action readbacks may contain mail: never give them a filesystem path. */
internal class ActionMemorySource(private val bytes: ByteArray) : MediaDataSource() {
    private var closed = false
    @Synchronized override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (closed || position >= bytes.size) return -1
        require(position >= 0)
        val count = minOf(size,bytes.size-position.toInt())
        bytes.copyInto(buffer,offset,position.toInt(),position.toInt()+count)
        return count
    }
    @Synchronized override fun getSize() = if (closed) 0L else bytes.size.toLong()
    @Synchronized override fun close() { closed = true; bytes.fill(0) }
}

class ActionAudioOutput(private val canStart: () -> Boolean) : VoiceOutput {
    private val main = Handler(Looper.getMainLooper())
    private var generation = 0L
    private var player: MediaPlayer? = null
    private var source: ActionMemorySource? = null
    private var timeout: Runnable? = null
    override fun play(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit) {
        main.post {
            stopNow(); val token = generation
            try {
                val memory = ActionMemorySource(audio.bytes()); source = memory
                val media = MediaPlayer(); player = media
                media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                media.setDataSource(memory)
                fun fail() { if (token == generation) { stopNow(); failed() } }
                timeout = Runnable { fail() }.also { main.postDelayed(it,6000) }
                media.setOnPreparedListener {
                    if (token != generation) return@setOnPreparedListener
                    timeout?.let { main.removeCallbacks(it) }; timeout = null
                    if (!canStart()) { fail(); return@setOnPreparedListener }
                    runCatching { media.start(); started() }.onFailure { fail() }
                }
                media.setOnCompletionListener { if (token == generation) { stopNow(); finished() } }
                media.setOnErrorListener { _,_,_ -> fail(); true }
                media.prepareAsync()
            } catch (_: Exception) { if (token == generation) { stopNow(); failed() } }
        }
    }
    private fun stopNow() {
        generation++; timeout?.let { main.removeCallbacks(it) }; timeout = null
        val media = player; player = null
        runCatching { media?.stop() }; runCatching { media?.release() }
        source?.close(); source = null
    }
    override fun stop() { main.post { stopNow() } }
    override fun pause() = stop()
    override fun resume() {}
    override fun close() = stop()
}
