package dev.mobi.voice
import dev.mobi.net.WavAudio
interface VoiceOutput : AutoCloseable {
    fun prepareInput(ready: () -> Unit, failed: () -> Unit) { ready() }
    fun play(audio: WavAudio, started: () -> Unit, finished: () -> Unit, failed: () -> Unit)
    fun pause()
    fun resume()
    fun stop()
}
