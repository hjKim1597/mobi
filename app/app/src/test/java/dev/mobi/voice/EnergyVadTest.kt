package dev.mobi.voice
import org.junit.Assert.*
import org.junit.Test
class EnergyVadTest {
 private fun frame(v:Int)=ShortArray(320){v.toShort()}
 @Test fun holdDetectsSpeechAfterTwelveSecondsOfSilenceWithoutEndingOrResettingCapture() {
  val vad=EnergyVad(CaptureMode.HOLD)
  repeat(600){assertFalse("hold must not end on silence",vad.push(frame(0)))}
  repeat(4){assertFalse(vad.push(frame(500)));assertFalse(vad.voiced)}
  assertFalse(vad.push(frame(500)));assertTrue(vad.voiced)
  repeat(34){assertFalse(vad.push(frame(0)))};assertTrue(vad.push(frame(0)))
 }
 @Test fun confirmAndQuestionUseDifferentSilenceAndEightSecondCap() {
  for ((mode,count) in listOf(CaptureMode.CONFIRM to 25,CaptureMode.QUESTION to 35)) {
   val vad=EnergyVad(mode); repeat(5){assertFalse(vad.push(frame(500)))}
   repeat(count-1){assertFalse(vad.push(frame(0)))}; assertTrue(vad.push(frame(0)))
   assertTrue(vad.voiced); assertEquals(1600,vad.lastVoicedSample)
  }
  val v=EnergyVad(CaptureMode.QUESTION); repeat(399){assertFalse(v.push(frame(500)))}
  assertTrue(v.push(frame(500))); assertEquals(128000,v.samples)
 }
 @Test fun silenceNoiseAndShortBurstDoNotBecomeSpeech() {
  for (amplitude in listOf(0,100)) { val v=EnergyVad(CaptureMode.QUESTION); repeat(400){v.push(frame(amplitude))}; assertFalse(v.voiced) }
  val v=EnergyVad(CaptureMode.CONFIRM); repeat(4){v.push(frame(1000))}; repeat(30){v.push(frame(0))}; assertFalse(v.voiced)
 }
 @Test fun wavHasCorrectHeaderAndSize() {
  val wav=AudioClip.wav(ShortArray(128000){1000}); assertEquals(256044,wav.size)
  assertEquals("RIFF",String(wav,0,4)); assertEquals("WAVE",String(wav,8,4))
  assertEquals(341392,java.util.Base64.getEncoder().encodeToString(wav).length)
 }
}
