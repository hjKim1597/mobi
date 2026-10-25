package dev.mobi.voice

import dev.mobi.net.CancelHandle
import dev.mobi.net.Operation
import dev.mobi.net.RequestDeadline
import dev.mobi.net.WavAudio
import dev.mobi.trip.Clock
import org.junit.Assert.assertArrayEquals
import org.junit.Test

class VoiceSessionPrivacyTest {
    @Test fun captureWavIsClearedAfterRequestEncodingAndRequestRemainsUsable() {
        val now = 100L
        val clip = AudioClip(AudioClip.wav(ShortArray(1600) { 1200 }), now, voiced = true)
        val original = clip.wav.copyOf()
        var submitted: WavAudio? = null
        val input = object : VoiceInput {
            override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit, result: (Result<AudioClip>) -> Unit): CancelHandle {
                result(Result.success(clip))
                return CancelHandle { }
            }
            override fun close() = Unit
        }
        val output = object : VoiceOutput {
            override fun play(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit) = Unit
            override fun pause() = Unit
            override fun resume() = Unit
            override fun stop() = Unit
            override fun close() = Unit
        }
        val clock = Clock { now }
        val session = VoiceSession(
            clock, input, output,
            { _, _, _ -> CancelHandle { } },
            { audio, _, _ -> submitted = audio; CancelHandle { } },
            { _, _, _ -> CancelHandle { } },
            { _, _ -> CancelHandle { } },
            { action -> action() },
            { true }, { true }, { action -> action() }, { }, { }, { },
        )

        try {
            session.listen(Operation(1, 1, 1, RequestDeadline(clock, now + 6000)), CaptureMode.CONFIRM)

            assertArrayEquals(ByteArray(original.size), clip.wav)
            assertArrayEquals(original, requireNotNull(submitted).bytes())
        } finally {
            session.close()
            original.fill(0)
        }
    }
}
