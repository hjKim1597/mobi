package dev.mobi.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import dev.mobi.net.WavAudio
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class ServerAudioOutput(context: Context) : VoiceOutput {
    val directory = File(context.cacheDir, "voice-output").apply { mkdirs(); listFiles().orEmpty().forEach { it.delete() } }
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val generation = AtomicLong()
    @Volatile private var player: MediaPlayer? = null
    @Volatile private var file: File? = null
    @Volatile private var paused = false
    private var progressCheck: Runnable? = null
    private var lastPosition = -1
    private var progressAt = 0L
    private var playbackUntil = Long.MAX_VALUE
    private var prepared = false
    private var cuePrepared = false
    private var prepareTimeout: Runnable? = null
    private var startCallback: (() -> Unit)? = null
    @Volatile var canStart: () -> Boolean = { true }
    override fun prepareInput(ready: () -> Unit, failed: () -> Unit) {
        prepare(acknowledgement, {}, {}, failed, ready)
    }
    fun acknowledge(started: () -> Unit, finished: () -> Unit, failed: () -> Unit) {
        main.post {
            synchronized(this) {
                val media = player
                if (!cuePrepared || !prepared || media == null) {
                    play(acknowledgement, started, finished, failed)
                    return@post
                }
                cuePrepared = false
                val token = generation.get()
                startCallback = started
                media.setOnCompletionListener { if (token == generation.get()) { stop(); finished() } }
                media.setOnErrorListener { _, _, _ -> if (token == generation.get()) { stop(); failed() }; true }
                monitorProgress(media, token, finished, failed)
                if (paused || !canStart()) { stop(); failed(); return@post }
                startPrepared()
            }
        }
    }

    override fun play(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit) {
        prepare(audio, started, finished, failed, null)
    }
    @Synchronized private fun prepare(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit, ready: (() -> Unit)?) {
        stop(); val token = generation.get()
        val timeout = Runnable { synchronized(this) { if (token == generation.get() && !prepared) { stop(); failed() } } }
        prepareTimeout = timeout
        main.postDelayed(timeout, 6000)
        io.execute {
            var temp: File? = null
            var bytes: ByteArray? = null
            try {
                val decoded = audio.bytes()
                bytes = decoded
                temp = File.createTempFile("reply-", ".wav", directory).also { it.writeBytes(decoded) }
                val path = temp
                main.post {
                    synchronized(this) {
                        if (token != generation.get()) { path.delete(); return@post }
                        file = path
                        try {
                            val media = MediaPlayer(); player = media
                            media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                            media.setDataSource(path.absolutePath)
                            media.setOnPreparedListener {
                                synchronized(this) {
                                    if (token != generation.get()) return@setOnPreparedListener
                                    prepared = true
                                    prepareTimeout?.let { main.removeCallbacks(it) }; prepareTimeout = null
                                    if (ready != null) { cuePrepared = true; ready(); return@setOnPreparedListener }
                                    monitorProgress(media, token, finished, failed)
                                    startCallback = started
                                    if (paused || !canStart()) { paused = true; return@setOnPreparedListener }
                                    startPrepared()
                                }
                            }
                            media.setOnCompletionListener { if (token == generation.get()) { stop(); finished() } }
                            media.setOnErrorListener { _, _, _ -> if (token == generation.get()) { stop(); failed() }; true }
                            media.prepareAsync()
                        } catch (e: Exception) { stop(); failed() }
                    }
                }
            } catch (e: Exception) { temp?.delete(); if (token == generation.get()) main.post { if (token == generation.get()) failed() } }
            finally { bytes?.fill(0) }
        }
    }
    @Synchronized override fun pause() {
        paused = true
        runCatching { player?.takeIf { it.isPlaying }?.pause() }
        Log.i("Mobi", "AUDIO_PAUSE atMs=${SystemClock.elapsedRealtime()}")
    }
    @Synchronized override fun resume() {
        if (cuePrepared || !canStart()) return
        paused = false
        if (prepared) startPrepared()
    }
    private fun startPrepared() {
        progressAt = SystemClock.elapsedRealtime()
        val remaining = runCatching { ((player?.duration ?: 0) - (player?.currentPosition ?: 0)).coerceAtLeast(0) }.getOrDefault(0)
        playbackUntil = progressAt + remaining + 2000L
        runCatching { player?.start() }.onSuccess {
            val callback = startCallback; startCallback = null
            if (callback != null) { Log.i("Mobi", "AUDIO_START atMs=${SystemClock.elapsedRealtime()}"); callback() }
        }
    }
    @Synchronized override fun stop() {
        generation.incrementAndGet(); paused = false; prepared = false; cuePrepared = false; startCallback = null
        prepareTimeout?.let { main.removeCallbacks(it) }; prepareTimeout = null
        progressCheck?.let { main.removeCallbacks(it) }; progressCheck = null
        val activePlayer = player; player = null
        runCatching { activePlayer?.stop() }
        runCatching { activePlayer?.release() }
        val activeFile = file; file = null
        runCatching { activeFile?.delete() }
        Log.i("Mobi", "AUDIO_STOP atMs=${SystemClock.elapsedRealtime()}")
    }
    private fun monitorProgress(media: MediaPlayer, token: Long, finished: () -> Unit, failed: () -> Unit) {
        lastPosition = -1; progressAt = SystemClock.elapsedRealtime()
        val check = object : Runnable {
            override fun run() {
                synchronized(this@ServerAudioOutput) {
                    if (token != generation.get() || player !== media) return
                    if (!paused) {
                        val position = runCatching { media.currentPosition }.getOrDefault(-1)
                        val duration = runCatching { media.duration }.getOrDefault(-1)
                        val playing = runCatching { media.isPlaying }.getOrDefault(false)
                        if (!playing && position > 0) Log.i("Mobi", "AUDIO_PROGRESS ended=true position=$position duration=$duration")
                        if (duration > 0 && position >= duration && !playing) {
                            Log.i("Mobi", "AUDIO_EOF recovered=true position=$position duration=$duration")
                            stop(); finished(); return
                        }
                        val now = SystemClock.elapsedRealtime()
                        if (position > lastPosition) { lastPosition = position; progressAt = now }
                        if (now - progressAt >= 3000 || now >= playbackUntil) {
                            Log.w("Mobi", "AUDIO_STALLED position=$position duration=$duration")
                            stop(); failed(); return
                        }
                    }
                    main.postDelayed(this, 250)
                }
            }
        }
        progressCheck = check
        main.postDelayed(check, 250)
    }

    override fun close() { stop(); io.shutdownNow() }
    private companion object {
        val acknowledgement = WavAudio(java.util.Base64.getEncoder().encodeToString(AudioClip.wav(ShortArray(1600) { i ->
            (kotlin.math.sin(2 * kotlin.math.PI * 660 * i / 16000) * 1500).toInt().toShort()
        })))
    }
}
