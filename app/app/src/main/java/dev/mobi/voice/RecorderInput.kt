package dev.mobi.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import dev.mobi.net.CancelHandle
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class RecorderInput internal constructor(
    private val context: Context,
    private val createRecorder: () -> AudioRecord,
    private val read: (AudioRecord, ShortArray) -> Int,
    private val silenced: (AudioRecord) -> Boolean?,
) : VoiceInput {
    constructor(context: Context) : this(context, {
        val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0)
        @Suppress("MissingPermission")
        AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minimum.coerceAtLeast(6400))
    }, { audio, frame -> audio.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING) },
        { it.activeRecordingConfiguration?.isClientSilenced })
    private val worker = Executors.newSingleThreadExecutor()
    private var current: CancelHandle? = null
    override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit, result: (Result<AudioClip>) -> Unit): CancelHandle {
        return start(mode, allowed, voiceStarted, result, ready = {})
    }
    override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit,
        result: (Result<AudioClip>) -> Unit, ready: () -> Unit): CancelHandle {
        current?.cancel()
        val cancelled = AtomicBoolean(false)
        val recorder = AtomicReference<AudioRecord?>()
        val handle = CancelHandle { cancelled.set(true); runCatching { recorder.get()?.stop() } }
        current = handle
        worker.execute {
            var audio: AudioRecord? = null
            val pcm = ShortArray(128000); val frame = ShortArray(320)
            var capturedPcm: ShortArray? = null
            var clip: AudioClip? = null; var failure: Throwable? = null
            var maxRms = 0.0; var above = 0; var longest = 0; var consecutive = 0
            try {
                check(!cancelled.get() && allowed() && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                val created = createRecorder()
                audio = created; recorder.set(created)
                check(created.state == AudioRecord.STATE_INITIALIZED)
                created.startRecording(); check(created.recordingState == AudioRecord.RECORDSTATE_RECORDING)
                check(!cancelled.get() && allowed() && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                val start = SystemClock.elapsedRealtime()
                val vad = EnergyVad(mode)
                var notified = false
                Log.i("Mobi", "RECORD_START atMs=$start")
                ready()
                while (!cancelled.get() && allowed()) {
                    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                    val count = read(created, frame)
                    check(count > 0)
                    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                    check(silenced(created) != true) // Configuration may not yet be available at startup.
                    val n = if (mode == CaptureMode.HOLD) count else count.coerceAtMost(pcm.size - vad.samples)
                    val rms = kotlin.math.sqrt((0 until n).sumOf { frame[it].toDouble() * frame[it] } / n)
                    maxRms = maxOf(maxRms, rms)
                    if (rms >= 200) { above++; consecutive++; longest = maxOf(longest, consecutive) } else consecutive = 0
                    if (mode != CaptureMode.HOLD) frame.copyInto(pcm, vad.samples, 0, n)
                    val ended = vad.push(frame, n)
                    if (vad.voiced && !notified) { notified = true; voiceStarted() }
                    if (ended || !vad.voiced && mode == CaptureMode.CONFIRM && vad.samples >= 96000) break
                }
                check(!cancelled.get() && allowed() && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                // Holding needs only speech onset, never a recording or transcription payload.
                val captured = if (mode == CaptureMode.HOLD) ShortArray(1) else pcm.copyOf(vad.samples)
                capturedPcm = captured
                clip = AudioClip(AudioClip.wav(captured), start + vad.lastVoicedSample / 16, vad.voiced)
                Log.i("Mobi", "RECORD_RESULT voiced=${vad.voiced} samples=${vad.samples} endpointMs=${SystemClock.elapsedRealtime()} lastVoiceMs=${clip.lastVoicedAtMillis}")
            } catch (e: Exception) { failure = e }
            finally {
                runCatching { audio?.stop() }
                runCatching { audio?.release() }
                recorder.set(null)
                capturedPcm?.fill(0); capturedPcm = null
                pcm.fill(0); frame.fill(0)
                Log.i("Mobi", "RECORD_METRICS maxRms=$maxRms framesAbove200=$above longestAbove200=$longest")
                Log.i("Mobi", "RECORD_END atMs=${SystemClock.elapsedRealtime()}")
            }
            if (!cancelled.get()) result(clip?.let { Result.success(it) } ?: Result.failure(failure ?: IllegalStateException("capture unavailable")))
            else clip?.wav?.fill(0)
        }
        return handle
    }
    fun cancelCurrent() { current?.cancel() }
    override fun close() { current?.cancel(); worker.shutdownNow() }
}
