package dev.mobi.cache
import androidx.test.platform.app.InstrumentationRegistry
import android.util.AtomicFile
import dev.mobi.net.*
import dev.mobi.voice.AudioClip
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.io.File
import java.util.Base64
class TodayCacheTest {
 @Test fun hashDateTimeZoneAtomicBundleAndOriginIsolation() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  var now=Instant.parse("2026-10-23T16:00:00Z")
  val c=TodayCache(ctx,"https://a.test","cache-test"){now}
  val wav=AudioClip.wav(ShortArray(1600){1000});val audio=WavAudio(Base64.getEncoder().encodeToString(wav))
  val hash=ApiContract.sha256(wav)
  val knock=KnockBundle("knock-v1","2026-10-24","Asia/Seoul",1,KnockAudio("online",audio,hash),KnockAudio("offline",audio,hash))
  val value=TodayResponse("2026-10-24","Asia/Seoul",listOf(CalendarEvent("1","fixture","2026-10-24","2026-10-25",true)),knock)
  try {
   assertNull(c.load());c.save(value);assertEquals(value,c.load())
   val stamps=c.directory.listFiles()!!.filter{it.extension=="wav"}.associate{it.name to it.lastModified()}
   c.save(value);assertEquals(stamps,c.directory.listFiles()!!.filter{it.extension=="wav"}.associate{it.name to it.lastModified()})
   assertNull(TodayCache(ctx,"https://b.test","cache-test"){now}.load())
   assertTrue(runCatching{c.save(value.copy(knock=knock.copy(online=knock.online.copy(sha256="0".repeat(64)))))}.isFailure)
   assertEquals(value,c.load())
   now=Instant.parse("2026-10-24T16:00:00Z");assertNull(c.load())
   now=Instant.parse("2026-10-23T16:00:00Z");c.directory.listFiles()!!.first{it.extension=="wav"}.writeBytes(byteArrayOf(0));assertNull(c.load())
   c.save(value)
   File(c.directory,"bundle.json").writeBytes("{\"date\":".toByteArray())
   assertNull(c.load())
  } finally {c.directory.deleteRecursively()}
 }

 @Test fun cachedDateUsesLocalCalendarAcrossDstSpringForwardAndMidnight() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  var now=Instant.parse("2026-03-08T09:30:00Z") // 01:30 PST, before the spring-forward gap.
  val c=TodayCache(ctx,"https://a.test","cache-dst-test"){now}
  val wav=AudioClip.wav(ShortArray(1600){1000})
  val audio=WavAudio(Base64.getEncoder().encodeToString(wav));val hash=ApiContract.sha256(wav)
  val knock=KnockBundle("knock-v1","2026-03-08","America/Los_Angeles",0,
   KnockAudio("online",audio,hash),KnockAudio("offline",audio,hash))
  val value=TodayResponse("2026-03-08","America/Los_Angeles",emptyList(),knock)
  try {
   c.save(value);assertEquals(value,c.load())
   now=Instant.parse("2026-03-08T10:30:00Z") // 03:30 PDT: one wall-clock hour later.
   assertEquals(value,c.load())
   now=Instant.parse("2026-03-09T06:59:59Z") // 23:59:59 PDT on the cached local date.
   assertEquals(value,c.load())
   now=Instant.parse("2026-03-09T07:00:00Z") // Local midnight starts the next cached date.
   assertNull(c.load())
  } finally {c.directory.deleteRecursively()}
 }

 @Test fun interruptedAtomicManifestWriteIsNeverReturnedAsTheCommittedBundle() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val now=Instant.parse("2026-10-23T16:00:00Z")
  val c=TodayCache(ctx,"https://a.test","cache-interrupted-test"){now}
  val wav=AudioClip.wav(ShortArray(1600){1000})
  val audio=WavAudio(Base64.getEncoder().encodeToString(wav));val hash=ApiContract.sha256(wav)
  val knock=KnockBundle("knock-v1","2026-10-24","Asia/Seoul",1,
   KnockAudio("online",audio,hash),KnockAudio("offline",audio,hash))
  val value=TodayResponse("2026-10-24","Asia/Seoul",listOf(CalendarEvent("1","fixture","2026-10-24","2026-10-25",true)),knock)
  val manifest=AtomicFile(File(c.directory,"bundle.json"))
  try {
   var pending=manifest.startWrite();pending.write("{\"date\":".toByteArray());pending.close()
   assertNull(c.load())

   c.save(value)
   pending=manifest.startWrite();pending.write("{\"date\":".toByteArray())
   assertEquals(value,c.load())
   pending.close()

   File(c.directory,"bundle.json").writeBytes("{\"date\":".toByteArray())
   assertNull(c.load())
  } finally {c.directory.deleteRecursively()}
 }
}
