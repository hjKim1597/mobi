package dev.mobi.voice

import dev.mobi.net.CancelHandle
import java.nio.ByteBuffer
import java.nio.ByteOrder

enum class CaptureMode { CONFIRM, QUESTION, HOLD }

data class AudioClip(val wav: ByteArray, val lastVoicedAtMillis: Long, val voiced: Boolean) {
    companion object {
        fun wav(samples: ShortArray, rate: Int = 16000): ByteArray {
            require(samples.size in 1..128000)
            val b = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            b.put("RIFF".toByteArray()).putInt(36 + samples.size * 2).put("WAVEfmt ".toByteArray()).putInt(16)
            b.putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
            b.put("data".toByteArray()).putInt(samples.size * 2)
            samples.forEach { b.putShort(it) }
            return b.array()
        }
    }
}

interface VoiceInput : AutoCloseable {
    fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit, result: (Result<AudioClip>) -> Unit): CancelHandle
    /** Legacy inputs cannot promise readiness; cancellation monitoring must fail closed for them. */
    fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit,
        result: (Result<AudioClip>) -> Unit, ready: () -> Unit): CancelHandle = start(mode, allowed, voiceStarted, result)
}
