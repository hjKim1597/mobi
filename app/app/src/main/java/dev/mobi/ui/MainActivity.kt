package dev.mobi.ui

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import dev.mobi.MobiService
import dev.mobi.MobiViewState

class MainActivity : Activity() {
    private lateinit var screen: MobiScreen
    private var service: MobiService? = null
    private var bound = false
    private var resumed = false
    private var pendingLiveRequest = false
    private var pendingGrantedLive = false

    // Keep this exact lambda instance for observe/removeObserver symmetry.
    private val observer: (MobiViewState) -> Unit = { viewState ->
        runOnUiThread { if (::screen.isInitialized) screen.render(viewState) }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val connected = (binder as? MobiService.LocalBinder)?.service ?: return
            service = connected
            bound = true
            connected.observe(observer)
            connected.setVisible(resumed)
            activateGrantedLiveIfReady()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service?.removeObserver(observer)
            service = null
            bound = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        screen = MobiScreen(this, ::handleAction)
        setContentView(screen)
        val serviceIntent = Intent(this, MobiService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(serviceIntent)
        else startService(serviceIntent)
    }

    override fun onStart() {
        super.onStart()
        bound = bindService(Intent(this, MobiService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        debugVisible(true)
        service?.setVisible(true)
        activateGrantedLiveIfReady()
    }

    override fun onPause() {
        resumed = false
        debugVisible(false)
        service?.setVisible(false)
        super.onPause()
    }

    override fun onStop() {
        service?.removeObserver(observer)
        if (bound) unbindService(connection)
        service = null
        bound = false
        super.onStop()
    }

    private fun debugVisible(visible: Boolean) {
        if (!dev.mobi.BuildConfig.DEBUG) return
        runCatching {
            Class.forName("dev.mobi.DebugControls").getMethod("visible", Activity::class.java, Boolean::class.javaPrimitiveType)
                .invoke(null, this, visible)
        }
    }

    private fun handleAction(action: String, tripId: Long) {
        val current = service ?: return
        val command = action.substringBefore('|')
        val actionIdentity = action.substringAfter('|', "").ifEmpty { null }
        when (command) {
            "accept" -> current.respond(tripId, true)
            "decline" -> current.respond(tripId, false)
            "demo" -> current.startDemo()
            "live" -> beginLive()
            "connect" -> current.connect()
            "speak" -> current.speak()
            "quiet_mail_set" -> current.setQuietMail(tripId, actionIdentity == "true")
            "action_reply", "action_calendar", "action_approve", "action_cancel",
            "action_decline", "action_demo_mail", "action_demo_voice", "action_demo_dictate",
            "action_demo_clarify" -> current.actionCommand(command, tripId, actionIdentity)
            // Demo card progression is local to MobiScreen and has no live side effect.
            "next" -> Unit
        }
    }

    private fun beginLive() {
        val requested = buildList {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                add(Manifest.permission.RECORD_AUDIO)
            }
        }.toTypedArray()
        if (requested.isEmpty()) {
            pendingGrantedLive = true
            activateGrantedLiveIfReady()
        } else {
            pendingGrantedLive = false
            pendingLiveRequest = true
            requestPermissions(requested, REQUEST_LIVE_PERMISSIONS)
        }
    }

    @Deprecated("Permission result API is kept minimal for the platform Activity.")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_LIVE_PERMISSIONS || !pendingLiveRequest) return
        pendingLiveRequest = false
        val microphoneGranted = permissions.indices.any { index ->
            permissions[index] == Manifest.permission.RECORD_AUDIO && grantResults.getOrNull(index) == PackageManager.PERMISSION_GRANTED
        } || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        pendingGrantedLive = microphoneGranted
        activateGrantedLiveIfReady()
    }

    private fun activateGrantedLiveIfReady() {
        if (!pendingGrantedLive || !resumed || !bound) return
        val target = service ?: return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            pendingGrantedLive = false
            target.startLive()
            target.promoteMicrophone(true)
        } else {
            pendingGrantedLive = false
        }
    }

    companion object {
        private const val REQUEST_LIVE_PERMISSIONS = 4102
    }
}
