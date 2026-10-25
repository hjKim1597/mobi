package dev.mobi

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import dev.mobi.dialog.DialogStateMachine
import dev.mobi.trip.Clock
import dev.mobi.trip.TripDetector
import dev.mobi.vehicle.Gear

/** DUMP-protected adb control surface. This entire class is absent from release. */
class DebugControls : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // -1 means identity was not shared. In that case the manifest's DUMP permission
        // remains authoritative; an ordinary application cannot reach this receiver.
        if (sentFromUid !in setOf(-1, 0, 2000, Process.myUid())) return
        val appContext = context.applicationContext
        val pending = goAsync()
        val handler = Handler(Looper.getMainLooper())
        var completed = false
        lateinit var connection: ServiceConnection
        fun finish() {
            if (completed) return
            completed = true
            runCatching { appContext.unbindService(connection) }
            pending.finish()
        }
        connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                val service = (binder as? MobiService.LocalBinder)?.service ?: return finish()
                service.onState {
                    try {
                        when (intent.getStringExtra("command")) {
                            "advance" -> {
                                val prefs = context.getSharedPreferences("debug", Context.MODE_PRIVATE)
                                val delta = intent.getLongExtra("millis", 0)
                                check(delta >= 0)
                                check(prefs.edit().putLong("offset", Math.addExact(prefs.getLong("offset", 0), delta)).commit())
                                service.liveDialog.tick(service.clock.elapsedRealtimeMillis())
                                service.demoDialog.tick(service.clock.elapsedRealtimeMillis())
                            }
                            "baseline" -> {
                                service.voice.cancel()
                                val snapshot = service.detector.snapshot.copy(
                                    tripId = service.detector.snapshot.tripId + 1,
                                    gear = Gear.UNKNOWN, parkedAtMillis = null,
                                    firstDeparturePending = false, knockConsumed = true,
                                    muted = false, dialogTerminal = "IDLE",
                                )
                                check(service.store.save(snapshot))
                                service.detector = TripDetector(service.clock, service.store)
                                service.detector.onBoot(service.bootCount)
                                service.liveDialog = DialogStateMachine().also { it.restore(snapshot.tripId, false) }
                                service.demo = false
                            }
                            "reset-clock" -> check(context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putLong("offset", 0).commit())
                            "sentence" -> service.finalSentence(intent.getLongExtra("tripId", 0), intent.getStringExtra("sentence").orEmpty())
                            "arm-capture" -> service.afterKnock = {
                                service.capture { allowed -> CaptureProbe.record(service, allowed) }
                            }
                            "disarm-capture" -> service.afterKnock = null
                            "capture-notification-action" -> {
                                val notification = service.getSystemService(NotificationManager::class.java).activeNotifications.single { it.id == 1 }.notification
                                capturedResponse = requireNotNull(notification.actions?.firstOrNull()?.actionIntent)
                            }
                            "send-captured-action" -> requireNotNull(capturedResponse).send()
                            "notification-actions" -> {
                                val notification = service.getSystemService(NotificationManager::class.java).activeNotifications.single { it.id == 1 }.notification
                                Log.i(MobiService.TAG, "NOTIFICATION actions=${notification.actions?.size ?: 0}")
                            }
                            "bounds" -> handler.post {
                                val name = intent.getStringExtra("view").orEmpty()
                                val request = intent.getStringExtra("request").orEmpty()
                                if (name in setOf("accept", "decline", "demo", "live", "next", "connect", "speak")) {
                                    val activity = visibleActivity?.get()
                                    val id = context.resources.getIdentifier(name, "id", context.packageName)
                                    val view = activity?.findViewById<android.view.View>(id)
                                    val rect = android.graphics.Rect()
                                    val bounds = if (view?.isShown == true && view.getLocalVisibleRect(rect) && rect.width() > 0 && rect.height() > 0) {
                                        val location = IntArray(2)
                                        view.getLocationOnScreen(location)
                                        "${location[0] + rect.left},${location[1] + rect.top},${location[0] + rect.right},${location[1] + rect.bottom}"
                                    } else "missing"
                                    val safeRequest = safeDebugRequest(request)
                                    Log.i(MobiService.TAG, "UI_BOUNDS request=$safeRequest view=$name bounds=$bounds")
                                }
                            }
                            "input-wav" -> {
                                check(java.io.File(context.filesDir, "voice-fixture.wav").isFile)
                                context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putBoolean("inputWav", true).commit()
                                service.setDebugInput { InjectedWavInput(java.io.File(context.filesDir, "voice-fixture.wav")) }
                            }
                            "input-reset" -> {
                                context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().remove("inputWav").commit()
                                service.setDebugInput(null)
                                java.io.File(context.filesDir, "voice-fixture.wav").delete()
                            }
                            "failure-baseline" -> check(context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putBoolean("failureCandidate", false).commit())
                            "failure-candidate" -> check(context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putBoolean("failureCandidate", true).commit())
                            "package-current" -> {
                                check(context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putBoolean("failureCandidate", false).commit())
                                Log.i(MobiService.TAG, "MEASURE_PACKAGE arm=current")
                            }
                            "package-candidate" -> {
                                check(context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putBoolean("failureCandidate", true).commit())
                                Log.i(MobiService.TAG, "MEASURE_PACKAGE arm=candidate")
                            }
                            "measure-confirm" -> service.measureVoice(dev.mobi.voice.CaptureMode.CONFIRM, requireNotNull(intent.getStringExtra("id")))
                            "measure-turn" -> service.measureVoice(dev.mobi.voice.CaptureMode.QUESTION, requireNotNull(intent.getStringExtra("id")))
                            "measure-briefing" -> service.measureBriefing(requireNotNull(intent.getStringExtra("id")))
                            "pair" -> service.connect()
                            "test-knock" -> service.debugKnock()
                            "endpoint" -> {
                                val url = intent.getStringExtra("url") ?: BuildConfig.MOBI_SERVER_BASE_URL
                                service.testEndpoint(url)
                                check(context.getSharedPreferences("debug", Context.MODE_PRIVATE).edit().putString("endpoint", url).commit())
                            }
                            "remaining-live" -> {
                                service.naviOverride = false
                                service.remainingSeconds = null
                            }
                            "remaining" -> {
                                service.naviOverride = true
                                service.remainingSeconds = intent.getStringExtra("seconds")?.toIntOrNull()
                            }
                            "nav-start" -> {
                                navTrack?.release()
                                val samples = ShortArray(16000 * 6) { 100 }
                                navTrack = android.media.AudioTrack.Builder()
                                    .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                                    .setAudioFormat(android.media.AudioFormat.Builder().setSampleRate(16000).setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT).build())
                                    .setTransferMode(android.media.AudioTrack.MODE_STATIC).setBufferSizeInBytes(samples.size * 2).build().apply { write(samples, 0, samples.size); play() }
                            }
                            "nav-stop" -> { navTrack?.release(); navTrack = null }
                            "state" -> Unit
                            else -> error("Unknown command")
                        }
                        service.publish()
                        Log.i(MobiService.TAG, "DEBUG_DONE command=${safeDebugCommand(intent.getStringExtra("command"))}")
                    } catch (failure: Exception) {
                        Log.e(MobiService.TAG, "DEBUG_ERROR reason=${failure.javaClass.simpleName}")
                    } finally {
                        handler.post { finish() }
                    }
                }
            }
            override fun onServiceDisconnected(name: ComponentName?) { finish() }
        }
        if (!appContext.bindService(Intent(appContext, MobiService::class.java), connection, 0)) finish()
        handler.postDelayed({ finish() }, 5000)
    }

    companion object {
        private var capturedResponse: PendingIntent? = null
        private var navTrack: android.media.AudioTrack? = null
        private var visibleActivity: java.lang.ref.WeakReference<android.app.Activity>? = null
        @JvmStatic fun visible(activity: android.app.Activity, visible: Boolean) {
            if (visible) visibleActivity = java.lang.ref.WeakReference(activity)
            else if (visibleActivity?.get() === activity) visibleActivity = null
        }
        @JvmStatic
        fun initialize(service: MobiService) {
            val prefs = service.getSharedPreferences("debug", Context.MODE_PRIVATE)
            val boot = service.bootCount ?: -1
            if (prefs.getInt("boot", -2) != boot) {
                check(prefs.edit().putInt("boot", boot).putLong("offset", 0).commit())
            }
            prefs.getString("endpoint", null)?.let { service.startupEndpoint(it) }
            val wav = java.io.File(service.filesDir, "voice-fixture.wav")
            if (prefs.getBoolean("inputWav", false) && wav.isFile) service.voiceInputFactory = { InjectedWavInput(wav) }
            service.clock = Clock { SystemClock.elapsedRealtime() + prefs.getLong("offset", 0) }
        }
    }
}

internal fun safeDebugCommand(command: String?): String = command?.takeIf {
    it in setOf("advance", "baseline", "reset-clock", "sentence", "arm-capture", "disarm-capture",
        "capture-notification-action", "send-captured-action", "notification-actions", "bounds", "input-wav",
        "input-reset", "failure-baseline", "failure-candidate", "package-current", "package-candidate",
        "measure-confirm", "measure-turn", "measure-briefing", "pair", "test-knock", "endpoint",
        "remaining-live", "remaining", "nav-start", "nav-stop", "state")
} ?: "unknown"

internal fun safeDebugRequest(request: String): String = request.takeIf { it.matches(Regex("[0-9]{1,20}")) } ?: "invalid"

/** Test-only digital input: real VAD and WAV upload, with no host acoustic dependency. */
class InjectedWavInput(private val file: java.io.File) : dev.mobi.voice.VoiceInput {
    private val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
    @Volatile private var active: dev.mobi.net.CancelHandle? = null
    override fun start(mode: dev.mobi.voice.CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit, result: (Result<dev.mobi.voice.AudioClip>) -> Unit): dev.mobi.net.CancelHandle {
        active?.cancel()
        val cancelled = java.util.concurrent.atomic.AtomicBoolean(false)
        val running = java.util.concurrent.atomic.AtomicReference<Thread?>()
        val handle = dev.mobi.net.CancelHandle { cancelled.set(true); running.get()?.interrupt() }
        active = handle
        worker.execute {
            running.set(Thread.currentThread())
            var data = ByteArray(0); var verifiedBytes = ByteArray(0); var samples = ShortArray(0); var frame = ShortArray(0); var used = ShortArray(0)
            var clip: dev.mobi.voice.AudioClip? = null; var error: Exception? = null
            try {
                check(!cancelled.get() && allowed()); require(file.length() in 44..256044)
                data = file.readBytes()
                verifiedBytes = dev.mobi.net.WavAudio(java.util.Base64.getEncoder().encodeToString(data)).bytes()
                verifiedBytes.fill(0); verifiedBytes = ByteArray(0)
                val b = java.nio.ByteBuffer.wrap(data).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                require(b.getShort(22).toInt() == 1 && b.getInt(24) == 16000 && b.getShort(34).toInt() == 16 && String(data, 36, 4) == "data")
                samples = ShortArray((data.size - 44) / 2) { b.getShort(44 + it * 2) }
                val vad = dev.mobi.voice.EnergyVad(mode)
                val start = SystemClock.elapsedRealtime()
                Log.i(MobiService.TAG, "RECORD_START source=debug-wav atMs=$start")
                var notified = false
                while (!cancelled.get() && allowed()) {
                    frame = ShortArray(320) { i -> samples.getOrElse(vad.samples + i) { 0 } }
                    val end = vad.push(frame)
                    frame.fill(0); frame = ShortArray(0)
                    Thread.sleep(20)
                    if (vad.voiced && !notified) { notified = true; voiceStarted() }
                    if (end || !vad.voiced && mode == dev.mobi.voice.CaptureMode.CONFIRM && vad.samples >= 96000) break
                }
                check(!cancelled.get() && allowed())
                used = ShortArray(vad.samples) { samples.getOrElse(it) { 0 } }
                clip = dev.mobi.voice.AudioClip(dev.mobi.voice.AudioClip.wav(used), start + vad.lastVoicedSample / 16, vad.voiced)
                Log.i(MobiService.TAG, "RECORD_RESULT voiced=${vad.voiced} samples=${vad.samples} endpointMs=${SystemClock.elapsedRealtime()} lastVoiceMs=${clip.lastVoicedAtMillis} source=debug-wav")
            } catch (e: Exception) { error = e }
            finally {
                data.fill(0); verifiedBytes.fill(0); samples.fill(0); frame.fill(0); used.fill(0); running.set(null); Thread.interrupted()
                Log.i(MobiService.TAG, "RECORD_END source=debug-wav atMs=${SystemClock.elapsedRealtime()}")
            }
            if (!cancelled.get()) result(clip?.let { Result.success(it) } ?: Result.failure(error ?: IllegalStateException("fixture unavailable")))
            else clip?.wav?.fill(0)
        }
        return handle
    }
    override fun close() { active?.cancel(); worker.shutdownNow() }
}
