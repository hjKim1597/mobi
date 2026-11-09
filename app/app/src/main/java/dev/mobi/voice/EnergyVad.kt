package dev.mobi.voice

import kotlin.math.sqrt

class EnergyVad(
    private val mode: CaptureMode,
    private val threshold: Double = 200.0,
) {
    var samples = 0; private set
    var voiced = false; private set
    var lastVoicedSample = 0; private set
    private var consecutive = 0
    fun push(frame: ShortArray, count: Int = frame.size): Boolean {
        require(count in 0..frame.size)
        if (count == 0) return mode != CaptureMode.HOLD && samples >= 128000
        val n = if (mode == CaptureMode.HOLD) count else count.coerceAtMost(128000 - samples)
        if (n <= 0) return true
        val rms = sqrt((0 until n).sumOf { frame[it].toDouble() * frame[it] } / n)
        samples += n
        if (rms >= threshold) {
            consecutive += n
            if (consecutive >= 1600) voiced = true
            if (voiced) lastVoicedSample = samples
        } else consecutive = 0
        val silence = if (mode == CaptureMode.CONFIRM) CONFIRM_ENDPOINT_SILENCE_SAMPLES else QUESTION_ENDPOINT_SILENCE_MS * 16
        return mode != CaptureMode.HOLD && samples >= 128000 || voiced && samples - lastVoicedSample >= silence
    }

    companion object {
        const val CONFIRM_ENDPOINT_SILENCE_SAMPLES = 8000
        const val QUESTION_ENDPOINT_SILENCE_MS = 700
    }
}
