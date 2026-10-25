package dev.mobi

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import kotlin.math.sqrt

/** Actual service-owned raw capture for A13. No PCM or transcript is persisted. */
object CaptureProbe {
    fun record(service: MobiService, allowed: () -> Boolean) {
        if (service.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED || !allowed()) return
        val size = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, maxOf(size, 32000))
        val buffer = ShortArray(16000)
        try {
            check(recorder.state == AudioRecord.STATE_INITIALIZED)
            recorder.startRecording()
            Log.i(MobiService.TAG, "CAPTURE_START atMs=${SystemClock.elapsedRealtime()}")
            var allZero = 0
            repeat(6) { second ->
                var count = 0
                var sumSquares = 0.0
                var peak = 0
                while (count < 16000 && allowed()) {
                    val read = recorder.read(buffer, 0, minOf(buffer.size, 16000 - count))
                    check(read > 0)
                    for (index in 0 until read) {
                        val sample = buffer[index].toInt()
                        peak = maxOf(peak, kotlin.math.abs(sample))
                        sumSquares += sample.toDouble() * sample
                    }
                    count += read
                }
                if (!allowed()) return
                if (peak == 0) allZero++
                val silenced = recorder.activeRecordingConfiguration?.isClientSilenced
                Log.i(MobiService.TAG, "CAPTURE_SECOND second=${second + 1} samples=$count peak=$peak rms=${sqrt(sumSquares / maxOf(count, 1))} silenced=$silenced")
            }
            Log.i(MobiService.TAG, "CAPTURE_DONE seconds=6 allZero=$allZero atMs=${SystemClock.elapsedRealtime()}")
        } catch (failure: Exception) {
            Log.e(MobiService.TAG, "CAPTURE_ERROR reason=${failure.javaClass.simpleName}")
        } finally {
            runCatching { recorder.stop() }
            runCatching { recorder.release() }
            buffer.fill(0)
        }
    }
}
