package dev.mobi.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.PI
import kotlin.math.sin

/** A local cue only; production speech/cached briefing belongs to A7. */
class KnockPlayer {
    private val worker = Executors.newSingleThreadExecutor()
    private val generation = AtomicInteger()
    @Volatile private var track: AudioTrack? = null

    fun play(started: () -> Unit = {}, finished: () -> Unit) {
        stop()
        val token = generation.get()
        worker.execute {
            val samples = ShortArray(4000) { index ->
                (sin(2 * PI * 660 * index / 16000) * 5000 * (1 - index.toDouble() / 4000)).toInt().toShort()
            }
            var audio: AudioTrack? = null
            try {
                if (generation.get() != token) return@execute
                audio = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(samples.size * 2).setTransferMode(AudioTrack.MODE_STATIC).build()
                track = audio
                check(audio.write(samples, 0, samples.size) == samples.size)
                if (generation.get() != token) return@execute
                audio.play()
                check(audio.playState == AudioTrack.PLAYSTATE_PLAYING)
                started()
                Thread.sleep(270)
            } finally {
                if (track === audio) track = null
                runCatching { audio?.stop() }
                audio?.release()
                if (generation.get() == token) finished()
            }
        }
    }

    fun stop() {
        generation.incrementAndGet()
        runCatching { track?.pause() }
    }

    fun close() {
        stop()
        worker.shutdownNow()
    }
}
