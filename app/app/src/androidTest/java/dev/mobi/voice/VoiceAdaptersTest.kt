package dev.mobi.voice
import androidx.test.platform.app.InstrumentationRegistry
import dev.mobi.net.WavAudio
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
class VoiceAdaptersTest {
 @Test fun initiallyUnknownRecordingConfigurationCanBecomeUnsilencedAndCaptureVoice() {
  captureWithUnknownConfiguration(true)
 }
 @Test fun recordingConfigurationCanStayUnknownThroughoutVoicedCapture() {
  captureWithUnknownConfiguration(false)
 }
 private fun captureWithUnknownConfiguration(becomesKnown:Boolean) {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val context=instrumentation.targetContext
  instrumentation.uiAutomation.grantRuntimePermission(context.packageName,android.Manifest.permission.RECORD_AUDIO)
  val native=java.util.concurrent.atomic.AtomicReference<android.media.AudioRecord>()
  val reads=java.util.concurrent.atomic.AtomicInteger()
  val queries=java.util.concurrent.atomic.AtomicInteger()
  val recording=java.util.concurrent.atomic.AtomicBoolean(true)
  val callbacks=java.util.concurrent.atomic.AtomicInteger()
  val voiceStarts=java.util.concurrent.atomic.AtomicInteger()
  val readyCalls=java.util.concurrent.atomic.AtomicInteger()
  val stateAtReady=java.util.concurrent.atomic.AtomicInteger(-1)
  val stateAtResult=java.util.concurrent.atomic.AtomicInteger(-1)
  val received=java.util.concurrent.atomic.AtomicReference<Result<AudioClip>>()
  val done=CountDownLatch(1)
  val input=RecorderInput(context,createRecorder={
   android.media.AudioRecord(android.media.MediaRecorder.AudioSource.MIC,16000,
    android.media.AudioFormat.CHANNEL_IN_MONO,android.media.AudioFormat.ENCODING_PCM_16BIT,6400).also{native.set(it)}
  },read={ audio,samples ->
   recording.compareAndSet(true,audio.recordingState==android.media.AudioRecord.RECORDSTATE_RECORDING)
   samples.fill(if(reads.incrementAndGet()<=5) 1000 else 0)
   samples.size
  },silenced={if(queries.incrementAndGet()>3 && becomesKnown) false else null})
  val activity=androidx.test.core.app.ActivityScenario.launch(dev.mobi.ui.MainActivity::class.java)
  try {
   input.start(CaptureMode.QUESTION,{true},{voiceStarts.incrementAndGet()},{result->
    stateAtResult.set(native.get().state);received.set(result);callbacks.incrementAndGet();done.countDown()
   },ready={stateAtReady.set(native.get().recordingState);readyCalls.incrementAndGet()})
   assertTrue("unknown configuration capture terminates",done.await(4,TimeUnit.SECONDS))
   assertTrue("positive reads from recording native AudioRecord",reads.get()>0 && recording.get())
   assertEquals("ready is delivered once after native recording starts",1,readyCalls.get())
   assertEquals(android.media.AudioRecord.RECORDSTATE_RECORDING,stateAtReady.get())
   assertTrue("unknown state must not reject voiced PCM",received.get().isSuccess)
   val clip=received.get().getOrThrow()
   assertTrue(clip.voiced);assertEquals(1,voiceStarts.get());assertEquals(1,callbacks.get())
   assertTrue(queries.get()>3)
   assertEquals("microphone released before result",android.media.AudioRecord.STATE_UNINITIALIZED,stateAtResult.get())
   val bytes=WavAudio(Base64.getEncoder().encodeToString(clip.wav)).bytes()
   assertEquals(25644,bytes.size)
  } finally {received.get()?.getOrNull()?.wav?.fill(0);input.close();activity.close()}
 }
 @Test fun holdKeepsTheSameRecorderReadyBeyondTenSecondsOfSilentPcm() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val context=instrumentation.targetContext
  instrumentation.uiAutomation.grantRuntimePermission(context.packageName,android.Manifest.permission.RECORD_AUDIO)
  val reads=java.util.concurrent.atomic.AtomicInteger()
  val creates=java.util.concurrent.atomic.AtomicInteger()
  val readyCalls=java.util.concurrent.atomic.AtomicInteger()
  val onset=java.util.concurrent.atomic.AtomicBoolean(false)
  val done=CountDownLatch(1)
  val native=java.util.concurrent.atomic.AtomicReference<android.media.AudioRecord>()
  val input=RecorderInput(context,createRecorder={
   creates.incrementAndGet()
   android.media.AudioRecord(android.media.MediaRecorder.AudioSource.MIC,16000,
    android.media.AudioFormat.CHANNEL_IN_MONO,android.media.AudioFormat.ENCODING_PCM_16BIT,6400).also{native.set(it)}
  },read={_,samples->samples.fill(if(reads.incrementAndGet()>600) 1000 else 0);samples.size},silenced={false})
  val activity=androidx.test.core.app.ActivityScenario.launch(dev.mobi.ui.MainActivity::class.java)
  try {
   input.start(CaptureMode.HOLD,{true},{onset.set(true);input.cancelCurrent();done.countDown()},
    {it.getOrNull()?.wav?.fill(0);done.countDown()},ready={
     assertEquals(android.media.AudioRecord.RECORDSTATE_RECORDING,native.get().recordingState)
     readyCalls.incrementAndGet()
    })
   assertTrue("hold reaches speech after twelve seconds of silent PCM",done.await(4,TimeUnit.SECONDS))
   assertTrue("silence must not end the hold capture",onset.get())
   assertTrue(reads.get()>600);assertEquals(1,creates.get());assertEquals(1,readyCalls.get())
  } finally {input.close();activity.close()}
 }
 @Test fun silencedRecorderDefersWithoutUploadAndReleasesMicrophone() {
  recorderFailure("silenced")
 }
 @Test fun negativeRecorderReadDefersWithoutUploadAndReleasesMicrophone() {
  recorderFailure("read-error")
 }
 @Test fun permissionLossDuringCaptureIncludingEndpointDefersAndReleasesMicrophone() {
  recorderFailure("permission",1)
  recorderFailure("permission",40)
 }
 private fun recorderFailure(fault:String,revokeAtRead:Int=0) {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val target=instrumentation.targetContext
  val permission=android.Manifest.permission.RECORD_AUDIO
  instrumentation.uiAutomation.grantRuntimePermission(target.packageName,permission)
  val revoked=java.util.concurrent.atomic.AtomicBoolean(false)
  val context=object:android.content.ContextWrapper(target) {
   override fun checkSelfPermission(name:String):Int =
    if(name==permission && revoked.get()) android.content.pm.PackageManager.PERMISSION_DENIED else super.checkSelfPermission(name)
  }
  val native=java.util.concurrent.atomic.AtomicReference<android.media.AudioRecord>()
  val frame=java.util.concurrent.atomic.AtomicReference<ShortArray>()
  val reads=java.util.concurrent.atomic.AtomicInteger()
  val recording=java.util.concurrent.atomic.AtomicBoolean(true)
  val received=java.util.concurrent.atomic.AtomicReference<Result<AudioClip>>()
  val callbacks=java.util.concurrent.atomic.AtomicInteger()
  val captured=CountDownLatch(1)
  val recorder=RecorderInput(context,createRecorder={
   android.media.AudioRecord(android.media.MediaRecorder.AudioSource.MIC,16000,
    android.media.AudioFormat.CHANNEL_IN_MONO,android.media.AudioFormat.ENCODING_PCM_16BIT,6400).also{native.set(it)}
  },read={ audio,samples ->
   recording.compareAndSet(true,audio.recordingState==android.media.AudioRecord.RECORDSTATE_RECORDING)
   val count=reads.incrementAndGet();frame.set(samples)
   samples.fill(if(count<=5) 1000 else 0)
   if(fault=="permission" && count==revokeAtRead)revoked.set(true)
   if(fault=="read-error") android.media.AudioRecord.ERROR_INVALID_OPERATION else samples.size
  },silenced={fault=="silenced"})
  val input=object:VoiceInput {
   override fun start(mode:CaptureMode,allowed:()->Boolean,voiceStarted:()->Unit,result:(Result<AudioClip>)->Unit)=
    recorder.start(mode,allowed,voiceStarted){value->received.set(value);callbacks.incrementAndGet();result(value);captured.countDown()}
   override fun close()=recorder.close()
  }
  var uploads=0;var plays=0;var effects=0;val events=mutableListOf<String>();var phase=""
  val output=object:VoiceOutput {
   override fun play(audio:WavAudio,started:()->Unit,finished:()->Unit,failed:()->Unit){plays++}
   override fun pause(){};override fun resume(){};override fun stop(){};override fun close(){}
  }
  val owner=android.os.HandlerThread("recorder-fault-test").apply{start()}
  val handler=android.os.Handler(owner.looper)
  val clock=dev.mobi.trip.Clock{android.os.SystemClock.elapsedRealtime()}
  val session=VoiceSession(clock,input,output,
   {_,_,_->uploads++;dev.mobi.net.CancelHandle{}},
   {_,_,_->uploads++;dev.mobi.net.CancelHandle{}},
   {_,_,_->uploads++;dev.mobi.net.CancelHandle{}},
   {_,_->dev.mobi.net.CancelHandle{}},{handler.post(it);Unit},{true},{true},
   {effects++;it()},{events+=it},{},{phase=it})
  val activity=androidx.test.core.app.ActivityScenario.launch(dev.mobi.ui.MainActivity::class.java)
  try {
   handler.post{session.listen(dev.mobi.net.Operation(1,1,1,dev.mobi.net.RequestDeadline(clock,clock.elapsedRealtimeMillis()+8000)),CaptureMode.QUESTION)}
   assertTrue("$fault/$revokeAtRead capture terminates",captured.await(4,TimeUnit.SECONDS))
   val idle=CountDownLatch(1);handler.post{idle.countDown()};assertTrue(idle.await(3,TimeUnit.SECONDS))
   assertTrue("fault was injected into a recording AudioRecord",reads.get()>0 && recording.get())
   assertEquals("native microphone released before result",android.media.AudioRecord.STATE_UNINITIALIZED,native.get().state)
   assertTrue("capture buffer erased",frame.get().all{it==0.toShort()})
   assertTrue("$fault/$revokeAtRead must reject the clip",received.get().isFailure)
   assertEquals(1,callbacks.get());assertEquals("deferred",events.last())
   assertEquals(1,events.count{it=="deferred"})
   assertEquals("IDLE",phase);assertNull(session.operation)
   assertEquals(0,uploads);assertEquals(0,plays);assertEquals(0,effects)
  } finally {
   val closed=CountDownLatch(1);handler.post{session.close();closed.countDown()};closed.await(3,TimeUnit.SECONDS)
   owner.quitSafely();owner.join(3000);activity.close()
  }
 }
 @Test fun mediaPlayerUsesWavHeaderAndDeletesTemporaryFilesOnCompletionAndCancellation() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val out=ServerAudioOutput(ctx)
  try {
   for(cancel in listOf(false,true)) {
    val done=CountDownLatch(1);val started=CountDownLatch(1)
    val wav=AudioClip.wav(ShortArray(4410){1000},44100)
    out.play(WavAudio(Base64.getEncoder().encodeToString(wav)),{started.countDown()},{done.countDown()},{done.countDown()})
    assertTrue(started.await(3,TimeUnit.SECONDS))
    if(cancel)out.stop() else assertTrue(done.await(3,TimeUnit.SECONDS))
    assertTrue(out.directory.listFiles().orEmpty().isEmpty())
   }
  } finally {out.close()}
 }
 @Test fun cancelledBeforePrepareDoesNotStartAndInputWithClosedGateCannotCapture() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val input=RecorderInput(ctx)
  val done=CountDownLatch(1)
  input.start(CaptureMode.QUESTION,{false},{},{assertTrue(it.isFailure);done.countDown()})
  assertTrue(done.await(3,TimeUnit.SECONDS));input.close()
  val out=ServerAudioOutput(ctx);val stopped=CountDownLatch(1)
  out.play(WavAudio("invalid"),{fail("invalid WAV started")},{},{stopped.countDown()})
  assertTrue(stopped.await(3,TimeUnit.SECONDS));out.close()
 }
 @Test fun preparedDuringNavigationReportsStartOnlyAfterResume() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val out=ServerAudioOutput(ctx);val started=CountDownLatch(1)
  out.canStart={false}
  try {
   out.play(WavAudio(Base64.getEncoder().encodeToString(AudioClip.wav(ShortArray(4410){1000},44100))),{started.countDown()},{},{})
   assertFalse(started.await(700,TimeUnit.MILLISECONDS))
   out.canStart={true};out.resume();assertTrue(started.await(2,TimeUnit.SECONDS))
  } finally {out.close()}
 }
 @Test fun debugWavInputExercisesVadWithoutAcousticLoopback() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val file=java.io.File(ctx.filesDir,"injected-unit.wav")
  val samples=ShortArray(48000){i->if(i in 8000 until 16000) 1000 else 0}
  file.writeBytes(AudioClip.wav(samples))
  val constructor=Class.forName("dev.mobi.InjectedWavInput").getConstructor(java.io.File::class.java)
  val input=constructor.newInstance(file) as VoiceInput
  val done=CountDownLatch(1);var clip:AudioClip?=null;var voice=false
  try {
   input.start(CaptureMode.QUESTION,{true},{voice=true},{clip=it.getOrThrow();done.countDown()})
   assertTrue(done.await(4,TimeUnit.SECONDS));assertTrue(voice);assertTrue(clip!!.voiced)
   assertTrue(clip!!.wav.size<=256044);clip!!.wav.fill(0)
  } finally {input.close();file.delete()}
 }
 @Test fun newRouteAfterCancellationCanPublishRemainingSeconds() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  var remaining:Int?=null
  val source=dev.mobi.vehicle.NaviSource(ctx){remaining=it}
  val field=source.javaClass.getDeclaredField("listener").apply{isAccessible=true}
  val listener=field.get(source) as ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
  try {
   listener.onRouteCancelled()
   listener.onRouteStarted(ai.pleos.playground.navi.data.RouteStartInfo(180,1000,0,"fixture",0))
   listener.onDestinationInfo(ai.pleos.playground.navi.data.DestinationInfo(0.0,0.0,null,null,"fixture","",1000,180,0,"","",""))
   assertEquals(180,remaining)
  } finally{source.close()}
 }
 @Test fun ordinaryFocusLossDefersWithoutPretendingNavigationIsActive() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  var lost=0;var paused=0;val navigation=mutableListOf<Boolean>()
  val focus=AudioFocus(ctx,{paused++},{navigation+=it},{lost++})
  try {
   val field=focus.javaClass.getDeclaredField("focusListener").apply{isAccessible=true}
   val listener=field.get(focus) as android.media.AudioManager.OnAudioFocusChangeListener
   listener.onAudioFocusChange(android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
   assertEquals(1,lost);assertTrue(paused>0);assertFalse(navigation.contains(true))
   focus.close();listener.onAudioFocusChange(android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
   assertEquals("closed focus must not affect a new session",1,lost)
  } finally{focus.close()}
 }
 @Test fun localAcknowledgementStartsWithinThreeHundredMilliseconds() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val out=ServerAudioOutput(ctx);val started=CountDownLatch(1);val finished=CountDownLatch(1)
  try {
   val ready=CountDownLatch(1)
   out.prepareInput({ready.countDown()},{ready.countDown()})
   assertTrue("acknowledgement prepared before input",ready.await(3,TimeUnit.SECONDS))
   out.resume()
   val field=out.javaClass.getDeclaredField("player").apply{isAccessible=true}
   assertFalse("prepared cue stays silent during input",(field.get(out) as android.media.MediaPlayer).isPlaying)
   out.acknowledge({started.countDown()},{finished.countDown()},{finished.countDown()})
   assertTrue("local acknowledgement start",started.await(300,TimeUnit.MILLISECONDS))
   assertTrue(finished.await(3,TimeUnit.SECONDS))
  } finally{out.close()}
 }
 @Test fun serviceDestructionClosesTheSessionOnItsOwningStateThread() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val bound=CountDownLatch(1);val installed=CountDownLatch(1);val closed=CountDownLatch(1)
  val closeThread=java.util.concurrent.atomic.AtomicReference<String>()
  var service:dev.mobi.MobiService?=null
  val connection=object:android.content.ServiceConnection {
   override fun onServiceConnected(name:android.content.ComponentName?,binder:android.os.IBinder?) {
    service=(binder as dev.mobi.MobiService.LocalBinder).service;bound.countDown()
   }
   override fun onServiceDisconnected(name:android.content.ComponentName?) {}
  }
  val intent=android.content.Intent(ctx,dev.mobi.MobiService::class.java)
  var connected=false
  val scenario=androidx.test.core.app.ActivityScenario.launch(dev.mobi.ui.MainActivity::class.java)
  try {
   connected=ctx.bindService(intent,connection,android.content.Context.BIND_AUTO_CREATE)
   assertTrue(bound.await(4,TimeUnit.SECONDS))
   service!!.onState {
    service!!.setDebugInput { object:VoiceInput {
     override fun start(mode:CaptureMode,allowed:()->Boolean,voiceStarted:()->Unit,result:(Result<AudioClip>)->Unit)=dev.mobi.net.CancelHandle{}
     override fun close(){closeThread.set(Thread.currentThread().name);closed.countDown()}
    } }
    installed.countDown()
   }
   assertTrue(installed.await(4,TimeUnit.SECONDS))
   scenario.close();ctx.unbindService(connection);connected=false
   assertTrue(ctx.stopService(intent))
   assertTrue(closed.await(4,TimeUnit.SECONDS))
   assertEquals("mobi-state",closeThread.get())
   val owner=service!!.javaClass.getDeclaredField("stateThread").apply{isAccessible=true}.get(service) as Thread
   owner.join(3000);assertFalse("state owner exits after cleanup",owner.isAlive)
   InstrumentationRegistry.getInstrumentation().waitForIdleSync()
  } finally {
   if(connected)ctx.unbindService(connection)
   scenario.close();ctx.stopService(intent)
  }
 }
 @Test fun repeatedAcknowledgementAndServerWavPlaybackAlwaysCompletes() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val out=ServerAudioOutput(ctx)
  val wav=AudioClip.wav(ShortArray(35280){i->if(i<8820)(kotlin.math.sin(2*kotlin.math.PI*440*i/44100)*1500).toInt().toShort() else 0},44100)
  val audio=WavAudio(Base64.getEncoder().encodeToString(wav))
  try {
   repeat(20){index->
    val ack=CountDownLatch(1);out.acknowledge({},{ack.countDown()},{ack.countDown()})
    assertTrue("ack $index",ack.await(3,TimeUnit.SECONDS))
    val ended=CountDownLatch(1);var error=false
    out.play(audio,{},{ended.countDown()},{error=true;ended.countDown()})
    assertTrue("reply completion $index",ended.await(3,TimeUnit.SECONDS));assertFalse(error)
   }
  } finally{out.close()}
 }
 @Test fun missingNativeCompletionAlwaysTerminatesAndReleasesAudio() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val out=ServerAudioOutput(ctx);val started=CountDownLatch(1);val ended=CountDownLatch(1);var failed=false
  try {
   val audio=WavAudio(Base64.getEncoder().encodeToString(AudioClip.wav(ShortArray(44100){1000},44100)))
   out.play(audio,{started.countDown()},{ended.countDown()},{failed=true;ended.countDown()})
   assertTrue(started.await(3,TimeUnit.SECONDS))
   InstrumentationRegistry.getInstrumentation().runOnMainSync {
    val field=out.javaClass.getDeclaredField("player").apply{isAccessible=true}
    (field.get(out) as android.media.MediaPlayer).setOnCompletionListener(null)
   }
   // Android may under-report position at native EOS. Only confirmed EOF is success;
   // otherwise the three-second progress watchdog must fail safely and release.
   assertTrue("missing completion must terminate",ended.await(5,TimeUnit.SECONDS))
   assertTrue(out.directory.listFiles().orEmpty().isEmpty())
  } finally{out.close()}
 }
}
