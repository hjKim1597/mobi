package dev.mobi

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import dev.mobi.dialog.DialogState
import dev.mobi.dialog.DialogStateMachine
import dev.mobi.dialog.SafetyGate
import dev.mobi.dialog.ActionStage
import dev.mobi.dialog.ActionView
import dev.mobi.voice.ActionSession
import dev.mobi.voice.ActionCancelReason
import dev.mobi.voice.ApiActionGateway
import dev.mobi.voice.ActionAudioOutput
import dev.mobi.voice.ActionAudioAssets
import dev.mobi.voice.DemoActionGateway
import dev.mobi.trip.Clock
import dev.mobi.trip.PreferencesTripStore
import dev.mobi.trip.TripDetector
import dev.mobi.ui.MainActivity
import dev.mobi.vehicle.Gear
import dev.mobi.vehicle.VehicleSnapshot
import dev.mobi.vehicle.VehicleSource
import dev.mobi.voice.Intent as SentenceIntent
import dev.mobi.voice.KnockPlayer
import dev.mobi.voice.RecorderInput
import dev.mobi.voice.ServerAudioOutput
import dev.mobi.voice.AudioFocus
import dev.mobi.voice.VoiceSession
import dev.mobi.voice.CaptureMode
import dev.mobi.voice.FailureAudioAssets
import dev.mobi.net.*
import dev.mobi.cache.TodayCache
import dev.mobi.ui.PairingController
import dev.mobi.ui.PairingView
import dev.mobi.vehicle.NaviSource
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

data class MobiViewState(
    val vehicle: VehicleSnapshot = VehicleSnapshot(),
    val state: DialogState = DialogState.IDLE,
    val tripId: Long = 0,
    val demo: Boolean = false,
    val micReady: Boolean = false,
    val today: TodayResponse? = null,
    val pairing: PairingView = PairingView(),
    val voicePhase: String = "IDLE",
    val message: String = "",
    val needsConnection: Boolean = false,
    val action: ActionView? = null,
    val quietMail: Boolean = false,

)

/** Owns the trip for the Android process; an Activity never owns car/audio lifetime. */
class MobiService : Service() {
    inner class LocalBinder : Binder() { val service: MobiService get() = this@MobiService }
    private val binder = LocalBinder()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var stateThread: HandlerThread
    private lateinit var worker: Handler
    private val captureWorker = Executors.newSingleThreadExecutor()
    private val captureCancelled = AtomicBoolean(false)
    private val observers = CopyOnWriteArraySet<(MobiViewState) -> Unit>()
    private val cue = KnockPlayer()
    private lateinit var vehicleSource: VehicleSource
    internal lateinit var store: PreferencesTripStore
    internal lateinit var detector: TripDetector
    internal var clock = Clock { SystemClock.elapsedRealtime() }
    internal var liveDialog = DialogStateMachine()
    internal var demoDialog = DialogStateMachine()
    @Volatile internal var demo = false
    internal var afterKnock: (() -> Unit)? = null
    private val ioClock = Clock { SystemClock.elapsedRealtime() }
    private lateinit var api: ApiClient
    private lateinit var auth: DeviceAuth
    private var credentials: DeviceCredentials? = null
    private var cache: TodayCache? = null
    private var today: TodayResponse? = null
    internal var voiceInputFactory: (() -> dev.mobi.voice.VoiceInput)? = null
    private lateinit var recorder: RecorderInput
    private lateinit var output: ServerAudioOutput
    private lateinit var failureAudioAssets: FailureAudioAssets
    private lateinit var focus: AudioFocus
    internal lateinit var voice: VoiceSession
    private lateinit var actions: ActionSession
    private lateinit var demoActions: ActionSession
    private lateinit var actionOutput: ActionAudioOutput
    private lateinit var demoActionOutput: ActionAudioOutput
    private var actionInput: dev.mobi.voice.VoiceInput? = null
    private var briefingForMail = false
    private val quietMailSetting = dev.mobi.trip.QuietMailSetting()
    private var quietMailLastGear = Gear.UNKNOWN
    private var quietMailEndAt: Long? = null
    private var quietMailEndTask: Runnable? = null
    private val currentActions get() = if (demo) demoActions else actions
    private lateinit var pairing: PairingController
    private lateinit var navi: NaviSource
    private var pairingView = PairingView()
    private var voicePhase = "IDLE"
    private var message = ""
    private var needsConnection = true
    private var credentialRejected = false
    private var ioSerial = 0L
    private var liveEnabled = false
    private var refresh: CancelHandle? = null
    private var dayTask: CancelHandle? = null
    private var retryAt = 0L
    private var networkGeneration = 0L
    internal var remainingSeconds: Int? = null
    internal var naviOverride = false
    private var serverBase = BuildConfig.MOBI_SERVER_BASE_URL
    private var initialized = false
    private var started = false
    private var demoSequence = -1L
    private data class MeasurementRun(val route: String, val id: String, var outcome: String? = null, var httpStatus: String? = null, var posted: Boolean = false)
    private var measurement: MeasurementRun? = null
    private var debugMeasurementOperation = false
    @Volatile private var destroyed = false
    @Volatile private var activityVisible = false
    @Volatile private var vehicle = VehicleSnapshot()
    @Volatile private var view = MobiViewState()
    @Volatile var micReady = false
        private set
    internal val bootCount: Int?
        get() = runCatching { Settings.Global.getInt(contentResolver, Settings.Global.BOOT_COUNT) }.getOrNull()
    private val activeDialog get() = if (demo) demoDialog else liveDialog

    override fun onCreate() {
        super.onCreate()
        stateThread = HandlerThread("mobi-state").also { it.start() }
        worker = Handler(stateThread.looper)
        store = PreferencesTripStore(getSharedPreferences("trip", MODE_PRIVATE))
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "차량 상태", NotificationManager.IMPORTANCE_LOW))
        // The optional initializer is declared only by the debug variant manifest.
        @Suppress("DEPRECATION")
        val initializer = packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            .metaData?.getString("dev.mobi.initializer")
        if (initializer != null) Class.forName(initializer).getMethod("initialize", MobiService::class.java).invoke(null, this)
        vehicleSource = VehicleSource(this) { snapshot ->
            vehicle = snapshot
            // Close interaction before queued disk writes, independent of callback ordering.
            deliver(view.copy(vehicle = snapshot))
            onState {
                if (!initialized) return@onState
                if (!SafetyGate.interactive(snapshot)) pairing.cancel()
                if (::actions.isInitialized) currentActions.safetyChanged()
                if (snapshot.gear != quietMailLastGear) {
                    val now = clock.elapsedRealtimeMillis()
                    val endAt = quietMailSetting.onGear(snapshot.gear, now)
                    quietMailLastGear = snapshot.gear
                    if (snapshot.gear != Gear.PARK) {
                        quietMailEndTask?.let(worker::removeCallbacks)
                        quietMailEndTask = null
                        quietMailEndAt = null
                    }
                    if (endAt != null) scheduleQuietMailReset(endAt)
                }
                val knock = detector.onGear(snapshot.gear)
                if (knock) beginLiveKnock()
                if (!knock && (snapshot.gear in setOf(Gear.DRIVE, Gear.REVERSE, Gear.NEUTRAL) || snapshot.uxKnown && snapshot.restricted)) {
                    activeDialog.onDriving(micReady)
                    if (!demo && activeDialog.state == DialogState.DEFERRED && voicePhase != "SPEAKING") voice.cancel()
                }
                publish()
            }
        }
        ensureStarted()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val stage = getSharedPreferences("stage", MODE_PRIVATE)
        val restore = intent == null && ServiceStagePolicy.shouldRestore(
            bootCount, stage.getInt("promotedBoot", -1), hasMicrophonePermission(),
        )
        foreground(micReady || restore)
        ensureStarted()
        if (intent?.action == RESPOND) {
            Log.i(TAG, "NOTIFICATION_RESPONSE trip=${intent.getLongExtra("tripId", 0)}")
            respond(intent.getLongExtra("tripId", 0), intent.getBooleanExtra("accept", false))
        }
        return START_STICKY
    }

    // A sticky service with bound clients may be recreated via onCreate/onBind
    // before Android delivers another start command. Initialize once for both paths.
    private fun ensureStarted() {
        if (started) return
        started = true
        val promotedBoot = getSharedPreferences("stage", MODE_PRIVATE).getInt("promotedBoot", -1)
        foreground(ServiceStagePolicy.shouldRestore(bootCount, promotedBoot, hasMicrophonePermission()))
        onState {
            initializeRuntime()
            detector = TripDetector(clock, store)
            val knock = detector.onBoot(bootCount)
            liveDialog.restore(detector.snapshot.tripId, detector.snapshot.muted, detector.snapshot.dialogTerminal)
            initialized = true
            if (knock) beginLiveKnock()
            publish()
        }
        vehicleSource.start()
    }

    private fun hasMicrophonePermission() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun foreground(microphone: Boolean) {
        val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
            if (microphone && hasMicrophonePermission()) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        try {
            startForeground(NOTIFICATION, notification(), type)
            micReady = type and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0
            Log.i(TAG, "FGS types=$type micReady=$micReady")
        } catch (failure: SecurityException) {
            micReady = false
            captureCancelled.set(true)
            startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            Log.w(TAG, "FGS_FALLBACK reason=${failure.javaClass.simpleName}")
        }
    }

    fun setVisible(visible: Boolean) {
        activityVisible = visible
        onState { if (::pairing.isInitialized && !visible) pairing.cancel() }
    }

    fun promoteMicrophone(visible: Boolean) {
        onState {
            if (demo || !SafetyGate.interactive(vehicle)) return@onState
            main.post {
                if (!ServiceStagePolicy.shouldPromote(visible && activityVisible, hasMicrophonePermission(), demo)) return@post
                foreground(true)
                val successful = micReady
                onState {
                    val boot = bootCount
                    if (successful && boot != null) {
                        getSharedPreferences("stage", MODE_PRIVATE).edit().putInt("promotedBoot", boot).commit()
                    }
                    publish()
                }
            }
        }
    }

    fun startLive() {
        if (!SafetyGate.interactive(vehicle)) return
        onState {
            if (!SafetyGate.interactive(vehicle)) return@onState
            cue.stop()
            if (::demoActions.isInitialized) demoActions.close()
            val returningFromDemo = demo
            demo = false
            if (BuildConfig.DEBUG) debugMeasurementOperation = false
            liveEnabled = true
            voice.cancel()
            if (returningFromDemo && ::actions.isInitialized) actions.resume()
            refreshToday()
            publish()
        }
    }

    fun startDemo() {
        if (!SafetyGate.interactive(vehicle)) return
        onState {
            if (!SafetyGate.interactive(vehicle)) return@onState
            if (::actions.isInitialized && actions.busy) { actions.interrupt(); return@onState }
            actions.suspend()
            demo = true
            initializeDemoActions()
            if (BuildConfig.DEBUG) debugMeasurementOperation = false
            liveEnabled = false
            pairing.cancel()
            refresh?.cancel(); refresh = null
            voice.cancel()
            captureCancelled.set(true)
            getSharedPreferences("stage", MODE_PRIVATE).edit().remove("promotedBoot").commit()
            main.post {
                foreground(false)
                onState {
                    demoDialog = DialogStateMachine()
                    demoDialog.startTrip(demoSequence--, clock.elapsedRealtimeMillis())
                    demoActions.begin(demoDialog.tripId, demoDialog.generation)
                    playKnock()
                }
            }
        }
    }

    fun respond(tripId: Long, accept: Boolean) {
        if (!SafetyGate.interactive(vehicle)) return
        onState {
            if (!SafetyGate.interactive(vehicle) || activeDialog.tripId != tripId) return@onState
            applySentence(if (accept) SentenceIntent.ACCEPT else SentenceIntent.DECLINE)
        }
    }

    internal fun finalSentence(tripId: Long, sentence: String) {
        onState {
            if (!micReady || activeDialog.tripId != tripId) return@onState
            applySentence(SentenceIntent.classify(sentence))
        }
    }

    private fun applySentence(intent: SentenceIntent) {
        val wasAwaiting = activeDialog.state == DialogState.AWAITING_RESPONSE
        activeDialog.respond(activeDialog.tripId, intent)
        if (activeDialog.muted && !demo) detector.mute()
        if (activeDialog.state != DialogState.AWAITING_RESPONSE && activeDialog.state != DialogState.KNOCKING) {
            cue.stop()
            captureCancelled.set(true)
        }
        if (!demo) {
            if (wasAwaiting && intent == SentenceIntent.ACCEPT && liveDialog.state == DialogState.BRIEFING) {
                Log.i(TAG, "ACCEPT atMs=${SystemClock.elapsedRealtime()}")
                voice.operation?.let { voice.accept(it) }
            } else if (intent in setOf(SentenceIntent.DECLINE, SentenceIntent.CANCEL, SentenceIntent.NOT_NOW)) voice.cancel()
        }
        publish()
    }

    internal fun debugKnock() {
        check(BuildConfig.DEBUG)
        if (demo || !SafetyGate.interactive(vehicle)) return
        beginLiveKnock()
    }

    private fun beginLiveKnock() {
        briefingForMail = false
        if (BuildConfig.DEBUG) debugMeasurementOperation = false
        if (demo) {
            // Keep the live trip aligned with the vehicle without interrupting a demo.
            liveDialog.restore(detector.snapshot.tripId, detector.snapshot.muted, "DEFERRED")
            detector.setDialogTerminal("DEFERRED")
            return
        }
        liveDialog.startTrip(detector.snapshot.tripId, clock.elapsedRealtimeMillis())
        beginActions()
        today = cache?.load()
        val op = Operation(liveDialog.tripId, liveDialog.generation, ++ioSerial, RequestDeadline(ioClock, ioClock.elapsedRealtimeMillis() + 6000))
        Log.i(TAG, "KNOCK trip=${op.tripId} demo=false atMs=${SystemClock.elapsedRealtime()}")
        publish()
        voice.startKnock(op, today?.knock, remainingSeconds, online() && !needsConnection && (micReady || SafetyGate.interactive(vehicle)))
    }

    private fun playKnock() {
        val dialog = activeDialog
        val trip = dialog.tripId
        val generation = dialog.generation
        publish()
        Log.i(TAG, "KNOCK trip=$trip demo=$demo atMs=${SystemClock.elapsedRealtime()}")
        cue.play(started = { Log.i(TAG, "CUE_PLAY trip=$trip atNs=${SystemClock.elapsedRealtimeNanos()}") }) {
            onState {
                if (activeDialog !== dialog || dialog.tripId != trip || dialog.generation != generation) return@onState
                dialog.knockFinished(trip, generation, clock.elapsedRealtimeMillis())
                if (vehicle.gear in setOf(Gear.DRIVE, Gear.REVERSE, Gear.NEUTRAL) || vehicle.uxKnown && vehicle.restricted) dialog.onDriving(micReady)
                publish()
                if (micReady && !demo && dialog.state == DialogState.AWAITING_RESPONSE) afterKnock?.invoke()
                worker.postDelayed({
                    if (activeDialog === dialog) {
                        dialog.tick(clock.elapsedRealtimeMillis())
                        publish()
                    }
                }, 6000)
            }
        }
    }

    internal fun onState(block: () -> Unit) { if (!destroyed) worker.post(block) }

    internal fun publish() {
        if (!initialized || destroyed) return
        if (!hasMicrophonePermission() && micReady) {
            micReady = false
            captureCancelled.set(true)
            if (::voice.isInitialized) voice.cancel()
            main.post { foreground(false) }
        }
        if (!demo && detector.snapshot.dialogTerminal != liveDialog.state.name) detector.setDialogTerminal(liveDialog.state.name)
        val state = MobiViewState(vehicle, activeDialog.state, activeDialog.tripId, demo, micReady, if (demo) null else today, pairingView, voicePhase, message, needsConnection, actionView(), quietMailSetting.enabled)
        main.post {
            if (destroyed) return@post
            deliver(state.copy(vehicle = vehicle))
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
        }
        Log.i(TAG, "STATE ${stateJson(state)}")
    }

    private fun stateJson(state: MobiViewState): JSONObject = JSONObject().apply {
        put("tripId", state.tripId); put("state", state.state.name); put("demo", state.demo)
        put("micReady", state.micReady); put("gear", state.vehicle.gear.name)
        put("interactive", SafetyGate.interactive(state.vehicle)); put("sourceNs", state.vehicle.sourceTimestampNanos)
        put("muted", if (state.demo) demoDialog.muted else detector.snapshot.muted)
        put("boot", bootCount); put("generation", activeDialog.generation)
        put("knockConsumed", detector.snapshot.knockConsumed)
        put("firstDeparturePending", detector.snapshot.firstDeparturePending)
        put("pairing", state.pairing.status); put("voicePhase", state.voicePhase)
        put("online", online())
        put("remainingSeconds", remainingSeconds ?: JSONObject.NULL)
        put("hasToday", state.today != null); put("eventCount", state.today?.events?.size ?: -1)
        put("needsConnection", needsConnection)
        if (::actions.isInitialized) { put("actionStage", currentActions.dialog.stage.name); put("actionOutcome", currentActions.outcome ?: JSONObject.NULL) }
    }

    internal fun reportState() { onState { publish() } }

    private fun deliver(state: MobiViewState) {
        view = state
        observers.forEach { it(state) }
    }

    fun observe(observer: (MobiViewState) -> Unit) {
        observers.add(observer)
        observer(view)
    }

    fun removeObserver(observer: (MobiViewState) -> Unit) { observers.remove(observer) }

    internal fun capture(block: (() -> Boolean) -> Unit) {
        if (!micReady || demo || !hasMicrophonePermission()) return
        captureCancelled.set(false)
        captureWorker.execute { block { !captureCancelled.get() && !destroyed && !demo && micReady && hasMicrophonePermission() } }
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_mobi).setContentTitle("Mobi")
            .setContentText(if (SafetyGate.interactive(vehicle)) "주차 중" else "운전 상태 확인 중")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
        if (SafetyGate.interactive(vehicle) && view.state == DialogState.AWAITING_RESPONSE) {
            for ((index, accept) in listOf(true, false).withIndex()) {
                val response = Intent(this, MobiService::class.java).setAction(RESPOND)
                    .setData(android.net.Uri.parse("mobi://response/${view.tripId}/$accept"))
                    .putExtra("tripId", view.tripId).putExtra("accept", accept)
                val pending = PendingIntent.getService(this, index + 1, response, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                builder.addAction(Notification.Action.Builder(null, if (accept) "들을래요" else "됐어요", pending).build())
            }
        }
        return builder.build()
    }

    private fun schedule(delay: Long, action: () -> Unit): CancelHandle {
        val runnable = Runnable { if (!destroyed) action() }
        worker.postDelayed(runnable, delay.coerceAtLeast(0))
        return CancelHandle { worker.removeCallbacks(runnable) }
    }

    private var runtimeReady = false

    private fun initializeRuntime() {
        if (runtimeReady) return
        runtimeReady = true
        api = ApiClient(serverBase, BuildConfig.DEBUG, ioClock)
        auth = DeviceAuth(this, serverBase)
        credentials = auth.load()
        needsConnection = credentials == null
        credentialRejected = false
        failureAudioAssets = FailureAudioAssets(this)
        logMeasurementConfig()
        cache = credentials?.let { TodayCache(this, serverBase, it.deviceId) }
        today = cache?.load()
        recorder = RecorderInput(this)
        output = ServerAudioOutput(this)
        focus = AudioFocus(this, { output.pause(); recorder.cancelCurrent(); if (::voice.isInitialized) voice.pauseInputImmediately(); cue.stop() }, { active -> onState { voice.onNavigation(active); if (active && ::actions.isInitialized) currentActions.interrupt(ActionCancelReason.FOCUS) } }, { onState {
            if (::actions.isInitialized) currentActions.interrupt(ActionCancelReason.FOCUS)
            if (voice.operation != null) { voice.cancel(); voiceEvent("deferred") }
        } })
        output.canStart = { !destroyed && !focus.refresh() }
        voice = VoiceSession(ioClock, voiceInputFactory?.invoke() ?: recorder, output,
            { request, deadline, cb -> credentials?.let { c ->
                val route = "/v1/briefings"; val id = measurementRequestId(route); measurePost(route, id)
                api.briefing(request.copy(tripId = wireTripId(request.tripId)), c, deadline) { result -> measureHttp(route, id, result); cb(result) }
            } ?: unavailable(cb) },
            { audio, deadline, cb -> credentials?.let { c ->
                val route = "/v1/confirm"; val id = measurementRequestId(route); measurePost(route, id)
                api.confirm(audio, c, deadline) { result -> measureHttp(route, id, result); cb(result) }
            } ?: unavailable(cb) },
            { audio, deadline, cb -> credentials?.let { c ->
                val route = "/v1/turns"; val id = measurementRequestId(route); measurePost(route, id)
                api.turn(wireTripId(liveDialog.tripId.toString()), audio, c, deadline) { result -> measureHttp(route, id, result); cb(result) }
            } ?: unavailable(cb) },
            ::schedule, { action -> onState(action) },
            { !destroyed && micReady && !demo && hasMicrophonePermission() && !liveDialog.muted },
            { focus.acquire() },
            { done -> if (!focus.refresh()) output.acknowledge(
                { Log.i(TAG, "EFFECT_START atMs=${SystemClock.elapsedRealtime()}") }, done,
                { onState { voice.cancel(); voiceEvent("deferred") } },
            ) else done() },
            ::voiceEvent, { intent ->
                if (BuildConfig.DEBUG && debugMeasurementOperation) {
                    debugMeasurementOperation = false
                    liveDialog.defer(liveDialog.tripId, liveDialog.generation)
                    voice.cancel()
                    publish()
                } else applySentence(intent)
            }, { phase -> voicePhase = phase; if (phase == "SPEAKING") cue.stop(); if (initialized) publish() },
            ::localFailureAudio, { operation, proposal -> onState {
                if (demo || liveDialog.tripId != operation.tripId || liveDialog.generation != operation.generation) return@onState
                beginActions()
                actions.receive(proposal, kindHint = "calendar_insert")
            } }, actionProposalPending = { operation, pending -> onState {
                if (demo || liveDialog.tripId != operation.tripId || liveDialog.generation != operation.generation) return@onState
                beginActions()
                actions.receivePending(pending.actionId, pending.version, operation.tripId, operation.generation)
            } })
        initializeActions()
        pairing = PairingController(ioClock, { System.currentTimeMillis() }, { credentials },
            { deadline, cb -> api.register(deadline) { result -> onState { cb(result) } } },
            { value -> auth.save(value); credentials = value; cache = TodayCache(this, serverBase, value.deviceId) },
            { c, deadline, cb -> api.createPairing(c, deadline) { result -> onState { cb(result) } } },
            { code, c, deadline, cb -> api.pollPairing(code, c, deadline) { result -> onState { cb(result) } } },
            ::schedule, { view -> pairingView = view; if (view.status == "paired") { needsConnection = false; refreshToday() }; if (initialized) publish() })
        navi = NaviSource(this) { seconds -> onState { if (!naviOverride) remainingSeconds = seconds } }
        navi.start()
        dayTask?.cancel()
        fun checkDay() {
            dayTask = schedule(60000) {
                if (liveEnabled && !demo && !needsConnection && online() && cache?.load() == null) {
                    today = null
                    refreshToday()
                }
                checkDay()
            }
        }
        checkDay()
    }

    private fun <T> unavailable(callback: (Result<T>) -> Unit): CancelHandle {
        schedule(0) { callback(Result.failure(ApiFailure(401, "UNAUTHORIZED"))) }
        return CancelHandle { }
    }

    private fun voiceEvent(event: String) {
        if (BuildConfig.DEBUG || !event.startsWith("confirm-decision-")) {
            Log.i(TAG, "VOICE_EVENT kind=$event trip=${liveDialog.tripId} atMs=${SystemClock.elapsedRealtime()}")
        }
        if (BuildConfig.DEBUG) trackMeasurementEvent(event)
        when (event) {
            "knock-started" -> Log.i(TAG, "CUE_PLAY trip=${liveDialog.tripId} atNs=${SystemClock.elapsedRealtimeNanos()}")
            "knock-finished" -> {
                liveDialog.knockFinished(liveDialog.tripId, liveDialog.generation, clock.elapsedRealtimeMillis())
                if (!SafetyGate.interactive(vehicle)) liveDialog.onDriving(micReady)
                if (liveDialog.state == DialogState.DEFERRED) voice.cancel()
                else if (afterKnock != null && micReady) { voice.cancel(); afterKnock?.invoke() }
                val id = liveDialog.tripId; val gen = liveDialog.generation
                schedule(6000) {
                    if (liveDialog.tripId == id && liveDialog.generation == gen) {
                        liveDialog.tick(clock.elapsedRealtimeMillis())
                        if (liveDialog.state == DialogState.DEFERRED) voice.cancel()
                        publish()
                    }
                }
            }
            "briefing-started" -> briefingForMail = true
            "voice-started" -> liveDialog.voiceStarted(liveDialog.tripId, liveDialog.generation)
            "deferred" -> { briefingForMail = false; liveDialog.defer(liveDialog.tripId, liveDialog.generation); message = getString(R.string.not_now) }
            "complete" -> {
                liveDialog.complete(liveDialog.tripId, liveDialog.generation); message = getString(R.string.briefing_complete)
                if (briefingForMail && !demo) { briefingForMail = false; beginActions(); actions.afterBriefing(remainingSeconds) }
            }
        }
        if ((event == "complete" || event == "deferred") && (!::actions.isInitialized || !currentActions.busy)) focus.release()
        publish()
    }

    private fun beginActions() {
        if (!::actions.isInitialized) return
        val prefs = getSharedPreferences(actionPreferenceName(), MODE_PRIVATE)
        actions.begin(liveDialog.tripId, liveDialog.generation, prefs.getLong("offeredTrip", Long.MIN_VALUE) == liveDialog.tripId)
    }

    private fun actionPreferenceName() = "actions-" + ApiContract.sha256(serverBase.toByteArray()).take(16)

    private fun initializeActions() {
        actionOutput = ActionAudioOutput { !destroyed && !focus.refresh() }
        actionInput = voiceInputFactory?.invoke() ?: RecorderInput(this)
        val assets = ActionAudioAssets(this)
        val prefs = getSharedPreferences(actionPreferenceName(), MODE_PRIVATE)
        actions = ActionSession(ioClock, { System.currentTimeMillis() }, ApiActionGateway(api) { credentials },
            requireNotNull(actionInput), actionOutput, ::schedule, { onState(it) },
            { !destroyed && !demo && micReady && hasMicrophonePermission() && !liveDialog.muted },
            { focus.acquire() }, { if (!demo && initialized) { voicePhase = actions.voicePhase; publish() } },
            { id -> prefs.edit().apply { if (id == null) remove("activeId") else putString("activeId", id) }.commit() },
            { wireTripId(it.toString()) }, assets::get,
            offerConsumed = { prefs.edit().putLong("offeredTrip", it).commit() },
            buttonPermitted = { !demo && SafetyGate.interactive(vehicle) },
            quietMail = { quietMailSetting.enabled }, diagnostic = { Log.i(TAG, it) })
        actions.offerConfirm = { audio, cb ->
            val c = credentials
            if (c == null) unavailable(cb) else api.confirm(audio,c,api.deadline(),cb)
        }
        initializeDemoActions()
        schedule(0) {
            beginActions()
            prefs.getString("activeId", null)?.let { actions.restore(it) }
        }
    }

    fun setQuietMail(tripId: Long, enabled: Boolean) {
        onState {
            if (demo || tripId != liveDialog.tripId || !SafetyGate.interactive(vehicle) ||
                !::actions.isInitialized || actions.busy || actions.voicePhase != "IDLE") return@onState
            quietMailSetting.set(enabled, clock.elapsedRealtimeMillis())
            publish()
        }
    }

    private fun scheduleQuietMailReset(parkedAtMillis: Long) {
        quietMailEndAt = parkedAtMillis
        val task = Runnable {
            val now = clock.elapsedRealtimeMillis()
            if (quietMailEndAt == parkedAtMillis && vehicle.gear == Gear.PARK &&
                quietMailSetting.finishTrip(parkedAtMillis, now)) publish()
            if (quietMailEndAt == parkedAtMillis) {
                quietMailEndAt = null
                quietMailEndTask = null
            }
        }
        quietMailEndTask = task
        worker.postDelayed(task, dev.mobi.trip.TripDetector.PARK_THRESHOLD_MILLIS)
    }

    private fun initializeDemoActions() {
        if (::demoActions.isInitialized) demoActions.close()
        if (::demoActionOutput.isInitialized) demoActionOutput.close()
        val assets = ActionAudioAssets(this)
        demoActionOutput = ActionAudioOutput { !destroyed && !focus.refresh() }
        val noInput = object : dev.mobi.voice.VoiceInput {
            override fun start(mode: CaptureMode, allowed: () -> Boolean, voiceStarted: () -> Unit,
                result: (Result<dev.mobi.voice.AudioClip>) -> Unit) = CancelHandle {}
            override fun close() {}
        }
        demoActions = ActionSession(ioClock, { System.currentTimeMillis() }, DemoActionGateway(assets),
            noInput, demoActionOutput, ::schedule, { onState(it) }, { false }, { focus.acquire() },
            { if (demo && initialized) { voicePhase = demoActions.voicePhase; publish() } }, {}, { "demo-$it" }, assets::get, demo = true, buttonPermitted = { demo && SafetyGate.interactive(vehicle) }, diagnostic = { Log.i(TAG, it) })
    }

    private fun actionView(): ActionView? {
        if (!::actions.isInitialized) return null
        val session = currentActions
        val stage = session.dialog.stage
        if (stage == ActionStage.IDLE) return null
        val display = session.proposal?.display ?: session.candidate?.display
        val title = when (stage) {
            ActionStage.OFFER -> display?.subject ?: "메일 확인"
            ActionStage.HOLDING -> "취소할 수 있어요"
            ActionStage.RESULT -> if (session.quietMailNotice) display?.subject ?: "메일이 도착했어요" else "처리 결과"
            ActionStage.UNKNOWN -> "처리 결과"
            ActionStage.DICTATING -> "답장 내용을 말씀해 주세요"
            ActionStage.CLARIFYING -> "일정 시간을 확인해 주세요"
            else -> if (session.kind == "mail_reply") "회신 내용 확인" else "일정 내용 확인"
        }
        val detail = when (stage) {
            ActionStage.RESULT -> if (session.quietMailNotice) listOfNotNull(
                display?.sender, display?.subject, display?.summary, session.resultText,
            ).joinToString("\n") else session.resultText
            ActionStage.UNKNOWN -> session.resultText
            ActionStage.HOLDING -> "십 초 동안 취소할 수 있어요."
            ActionStage.READBACK, ActionStage.AWAITING_APPROVAL -> session.proposal?.sentences?.joinToString("\n") { it.text }.orEmpty()
            else -> listOfNotNull(display?.sender,display?.subject,display?.summary).joinToString("\n")
        }
        return ActionView(when (stage) {
            ActionStage.OFFER -> "offer"
            ActionStage.DICTATING -> "dictation"
            ActionStage.READBACK -> "readback"
            ActionStage.AWAITING_APPROVAL -> "approval"
            ActionStage.HOLDING -> "holding"
            ActionStage.CLARIFYING -> "clarification"
            ActionStage.RESULT, ActionStage.UNKNOWN -> "result"
            else -> "processing"
        }, session.kind, title, detail, session.kind == "mail_reply" && session.candidate?.canReply == true,
            session.candidate?.canAddCalendar == true, session.readbackFinished, demo, session.dialog.token().toString())
    }

    fun actionCommand(command: String, tripId: Long, identity: String? = null) {
        if (!SafetyGate.interactive(vehicle)) return
        onState {
            if (!SafetyGate.interactive(vehicle) || activeDialog.tripId != tripId) return@onState
            val session = currentActions
            if (identity != null && identity != session.dialog.token().toString()) return@onState
            if (session.dialog.tripId != activeDialog.tripId) session.begin(activeDialog.tripId,activeDialog.generation)
            when (command) {
                "action_reply" -> session.acceptOffer(false)
                "action_calendar" -> session.acceptOffer(true)
                "action_approve" -> session.approveButton()
                "action_cancel" -> session.cancel()
                "action_decline" -> session.decline()
                "action_demo_mail" -> if (demo) session.afterBriefing(null)
                "action_demo_voice" -> if (demo) session.demoVoice()
                "action_demo_dictate" -> if (demo) session.demoDictate()
            }
            publish()
        }
    }

    internal fun debugActionScan() {
        check(BuildConfig.DEBUG)
        if (demo) return
        voice.cancel(); beginActions(); actions.afterBriefing(remainingSeconds)
    }

    private fun wireTripId(tripId: String) = "${bootCount ?: -1}-$tripId"

    private fun localFailureAudio(mode: CaptureMode): WavAudio? {
        if (BuildConfig.DEBUG && !getSharedPreferences("debug", MODE_PRIVATE).getBoolean("failureCandidate", true)) return null
        return failureAudioAssets.forMode(mode)
    }

    private fun logMeasurementConfig() {
        if (!BuildConfig.DEBUG) return
        val origin = if (serverBase == MOBI_DEV_ORIGIN) MOBI_DEV_ORIGIN else "other"
        val packageArm = if (getSharedPreferences("debug", MODE_PRIVATE).getBoolean("failureCandidate", true)) "candidate" else "current"
        Log.i(TAG, "MEASURE_CONFIG origin=$origin paired=${credentials != null && !needsConnection} package=$packageArm")
    }

    private fun measurementRequestId(route: String): String = if (!BuildConfig.DEBUG) "auto"
    else measurement?.takeIf { it.route == route && debugMeasurementOperation }?.id ?: "auto"

    private fun measurePost(route: String, id: String) {
        if (!BuildConfig.DEBUG) return
        measurement?.takeIf { it.route == route && it.id == id }?.posted = true
        Log.i(TAG, "MEASURE_POST route=$route id=$id atMs=${SystemClock.elapsedRealtime()}")
    }

    private fun measureHttp(route: String, id: String, result: Result<*>) {
        if (!BuildConfig.DEBUG) return
        val status = if (result.isSuccess) "200" else measurementStatus(result.exceptionOrNull() ?: IllegalStateException())
        Log.i(TAG, "MEASURE_HTTP route=$route id=$id status=$status atMs=${SystemClock.elapsedRealtime()}")
        onState { measurement?.takeIf { it.route == route && it.id == id }?.httpStatus = status }
    }

    private fun beginMeasurement(route: String, id: String): MeasurementRun {
        check(BuildConfig.DEBUG)
        require(route in MEASURE_ROUTES && id.matches(MEASURE_ID))
        logMeasurementConfig()
        val run = MeasurementRun(route, id)
        measurement = run
        Log.i(TAG, "MEASURE_START route=$route id=$id atMs=${SystemClock.elapsedRealtime()}")
        return run
    }

    private fun finishMeasurement(run: MeasurementRun, outcome: String, status: String) {
        if (!BuildConfig.DEBUG) return
        if (measurement !== run) return
        measurement = null
        Log.i(TAG, "MEASURE_DONE route=${run.route} id=${run.id} outcome=$outcome status=$status atMs=${SystemClock.elapsedRealtime()}")
    }

    private fun trackMeasurementEvent(event: String) {
        if (!BuildConfig.DEBUG) return
        val run = measurement ?: return
        if (event == "deferred") {
            finishMeasurement(run, if (run.posted) "error" else "suppressed", run.httpStatus ?: if (run.posted) "timeout" else "error")
            return
        }
        when (run.route) {
            "/v1/confirm" -> when {
                event.startsWith("confirm-decision-") -> finishMeasurement(run, "useful", "200")
                event.startsWith("confirm-result-") && event != "confirm-result-success" -> {
                    val status = event.substringAfterLast('-').takeIf { it in MEASURE_STATUSES } ?: "error"
                    finishMeasurement(run, "error", run.httpStatus ?: status)
                }
            }
            "/v1/turns" -> when {
                event == "turn-result-decision" -> finishMeasurement(run, "useful", "200")
                event.startsWith("turn-result-") && event !in setOf("turn-result-useful", "turn-result-degraded") -> {
                    val status = event.substringAfterLast('-').takeIf { it in MEASURE_STATUSES } ?: "error"
                    finishMeasurement(run, "error", run.httpStatus ?: status)
                }
                event == "turn-result-useful" -> run.outcome = "useful"
                event == "turn-result-degraded" -> run.outcome = "degraded"
                event == "turn-started" -> finishMeasurement(run, run.outcome ?: "useful", "200")
            }
        }
    }

    internal fun measureVoice(mode: CaptureMode, id: String) {
        check(BuildConfig.DEBUG)
        onState {
            val route = if (mode == CaptureMode.CONFIRM) "/v1/confirm" else "/v1/turns"
            if (measurement != null || !prepareMeasurementSlot()) return@onState
            val run = beginMeasurement(route, id)
            if (!measurementAllowed(requireFixture = true)) {
                finishMeasurement(run, "suppressed", "error"); return@onState
            }
            afterKnock = null
            val tripId = detector.snapshot.tripId
            liveDialog.startTrip(tripId, clock.elapsedRealtimeMillis())
            liveDialog.knockFinished(tripId, liveDialog.generation, clock.elapsedRealtimeMillis())
            val operation = Operation(tripId, liveDialog.generation, ++ioSerial, RequestDeadline(ioClock, ioClock.elapsedRealtimeMillis() + 6000))
            debugMeasurementOperation = true
            voice.listen(operation, mode)
            publish()
        }
    }

    internal fun measureBriefing(id: String) {
        check(BuildConfig.DEBUG)
        onState {
            if (measurement != null || !prepareMeasurementSlot()) return@onState
            val run = beginMeasurement("/v1/briefings", id)
            val c = credentials
            if (!measurementAllowed(requireFixture = false) || c == null || needsConnection) {
                finishMeasurement(run, "suppressed", "error"); return@onState
            }
            val request = BriefingRequest(liveDialog.tripId.toString(), remainingSeconds)
            val deadline = api.deadline()
            measurePost(run.route, run.id)
            api.briefing(request.copy(tripId = wireTripId(request.tripId)), c, deadline) { result ->
                measureHttp(run.route, run.id, result)
                onState {
                if (measurement !== run) return@onState
                result.fold(
                    { finishMeasurement(run, "useful", "200") },
                    { finishMeasurement(run, "error", measurementStatus(it)) },
                )
            } }
        }
    }

    private fun measurementAllowed(requireFixture: Boolean): Boolean =
        BuildConfig.DEBUG && serverBase == MOBI_DEV_ORIGIN && !destroyed && activityVisible && !demo && micReady && hasMicrophonePermission() &&
            credentials != null && !needsConnection &&
            !liveDialog.muted && SafetyGate.interactive(vehicle) && !focus.refresh() &&
            (!requireFixture || voiceInputFactory != null)

    private fun prepareMeasurementSlot(): Boolean {
        if (!debugMeasurementOperation && (voice.operation != null || liveDialog.state in MEASUREMENT_BLOCKED_STATES)) return false
        if (debugMeasurementOperation) {
            voice.cancel()
            liveDialog.restore(detector.snapshot.tripId, muted = false, terminal = DialogState.IDLE.name)
        }
        debugMeasurementOperation = false
        return voice.operation == null
    }

    private fun measurementStatus(failure: Throwable): String = (failure as? ApiFailure)?.let {
        when {
            it.code == "TIMEOUT" -> "timeout"
            it.status in 400..499 -> "4xx"
            it.status in 500..599 -> "5xx"
            else -> "error"
        }
    } ?: "error"

    fun connect() {
        onState {
            if (!activityVisible || demo || !SafetyGate.interactive(vehicle)) return@onState
            liveEnabled = true
            if (credentialRejected) {
                auth.clear(); credentials = null; cache = null; today = null; credentialRejected = false
            }
            pairing.begin()
        }
    }

    fun speak() {
        onState {
            if (demo || !activityVisible || !SafetyGate.interactive(vehicle) || !micReady || credentials == null || needsConnection || liveDialog.muted) return@onState
            if (BuildConfig.DEBUG) debugMeasurementOperation = false
            if (::actions.isInitialized && actions.busy) return@onState
            briefingForMail = false
            liveDialog.question()
            beginActions()
            val op = Operation(liveDialog.tripId, liveDialog.generation, ++ioSerial, RequestDeadline(ioClock, ioClock.elapsedRealtimeMillis() + 6000))
            voice.listen(op, CaptureMode.QUESTION)
            publish()
        }
    }

    private fun online(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java)
        return manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    }

    private fun refreshToday() {
        val c = credentials ?: return
        if (demo || refresh != null || ioClock.elapsedRealtimeMillis() < retryAt) return
        val epoch = networkGeneration
        refresh = api.today(c, api.deadline()) { result -> onState {
            if (epoch != networkGeneration || demo) return@onState
            refresh = null
            result.fold({ value ->
                runCatching { cache?.save(value) }.onSuccess { today = cache?.load(); needsConnection = false; credentialRejected = false; message = "" }.onFailure { message = getString(R.string.not_now) }
            }, { failure ->
                if (failure is ApiFailure && failure.status in setOf(401, 403)) {
                    needsConnection = true
                    credentialRejected = failure.status == 401
                }
                if (failure is ApiFailure && failure.status == 429) retryAt = ioClock.elapsedRealtimeMillis() + failure.retryAfterSeconds * 1000
                message = getString(if (failure is ApiFailure && failure.status in setOf(401, 403)) R.string.connect_required else R.string.not_now)
            })
            publish()
        } }
    }

    internal fun setDebugInput(factory: (() -> dev.mobi.voice.VoiceInput)?) {
        check(BuildConfig.DEBUG)
        voiceInputFactory = factory
        testEndpoint(serverBase)
    }

    internal fun startupEndpoint(url: String) {
        check(BuildConfig.DEBUG)
        serverBase = url
    }

    internal fun testEndpoint(url: String) {
        check(BuildConfig.DEBUG)
        ApiClient(url, true, ioClock).close() // Validate before discarding the current runtime.
        networkGeneration++
        actions.close(); demoActions.close(); actionOutput.close(); demoActionOutput.close(); actionInput?.close()
        pairing.cancel(); refresh?.cancel(); refresh = null; voice.close(); recorder.close(); focus.close(); api.close(); navi.close()
        serverBase = url; retryAt = 0; liveEnabled = false
        // Rebuild only the origin-bound runtime, preserving all trip state.
        rebuildRuntime()
    }

    private fun rebuildRuntime() {
        runtimeReady = false
        initializeRuntime()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        destroyed = true
        captureCancelled.set(true)
        observers.clear()
        vehicleSource.close()
        main.removeCallbacksAndMessages(null)
        // Drain already queued state work, then close its resources on that same owner.
        worker.post {
            if (::actions.isInitialized) { actions.interrupt(); actions.close(); demoActions.close(); actionOutput.close(); demoActionOutput.close(); actionInput?.close() }
            if (::voice.isInitialized) voice.close()
            if (::recorder.isInitialized) recorder.close()
            if (::focus.isInitialized) focus.close()
            if (::pairing.isInitialized) pairing.cancel()
            if (::navi.isInitialized) navi.close()
            refresh?.cancel(); dayTask?.cancel()
            if (::api.isInitialized) api.close()
            cue.close()
            captureWorker.shutdownNow()
            worker.removeCallbacksAndMessages(null)
            stateThread.quitSafely()
        }
        super.onDestroy()
    }

    companion object {
        private const val MOBI_DEV_ORIGIN = "https://mobi-dev.mobi-car.workers.dev"
        private val MEASURE_ROUTES = setOf("/v1/confirm", "/v1/turns", "/v1/briefings")
        private val MEASURE_STATUSES = setOf("200", "4xx", "5xx", "error", "timeout", "suppressed")
        private val MEASUREMENT_BLOCKED_STATES = setOf(DialogState.KNOCKING, DialogState.AWAITING_RESPONSE, DialogState.BRIEFING)
        private val MEASURE_ID = Regex("[A-Za-z0-9._-]{1,40}")
        const val BOOT = "dev.mobi.BOOT"
        const val RESPOND = "dev.mobi.RESPOND"
        const val TAG = "Mobi"
        private const val CHANNEL = "mobi-trip"
        private const val NOTIFICATION = 1
    }
}
