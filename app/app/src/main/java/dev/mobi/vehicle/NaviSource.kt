package dev.mobi.vehicle

import android.content.Context
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import ai.pleos.playground.navi.data.DestinationInfo
import ai.pleos.playground.navi.data.DrivingInfo
import ai.pleos.playground.navi.data.RouteStateInfo
import ai.pleos.playground.navi.data.RouteStartInfo
import ai.pleos.playground.navi.data.DestinationArrivedInfo
import ai.pleos.playground.navi.constants.NaviErrorCode

/** Read-only subscription. No routing/search or navigation UI calls. */
class NaviSource(context: Context, private val changed: (Int?) -> Unit) : AutoCloseable {
    private val helper = NaviHelper(context.applicationContext)
    @Volatile private var closed = false
    @Volatile private var routing: Boolean? = null
    private val listener = object : NaviHelperEventListener {
        override fun onRouteStarted(routeStartInfo: RouteStartInfo) {
            if (!closed) { routing = true; runCatching { helper.getDestinationInfo() } }
        }
        override fun onDestinationInfo(destinationInfo: DestinationInfo) { if (!closed && routing != false) changed(seconds(destinationInfo.remainTime)) }
        override fun onDrivingInfo(drivingInfo: DrivingInfo) { if (!closed && routing != false) changed(seconds(drivingInfo.destination.duration)) }
        override fun onRouteStateInfo(routeStateInfo: RouteStateInfo) { routing = routeStateInfo.isRouting; if (!routeStateInfo.isRouting) changed(null) }
        @Suppress("OVERRIDE_DEPRECATION") override fun onRouteEnded() = absent()
        override fun onRouteCancelled() = absent()
        override fun onDestinationArrived(destinationArrivedInfo: DestinationArrivedInfo) = absent()
        override fun onError(errorCode: NaviErrorCode) = absent()
    }
    private fun absent() { if (!closed) { routing = false; changed(null) } }
    fun start() {
        runCatching {
            helper.addListener(listener)
            helper.initialize({ if (!closed) { helper.getRouteStateInfo(); helper.getDestinationInfo() } }, { absent() })
        }.onFailure { absent() }
    }
    override fun close() { closed = true; runCatching { helper.removeListener(listener); helper.release() } }
    companion object {
        fun seconds(value: Int): Int? = value.takeIf { it >= 0 }
        fun bucket(remainingSeconds: Int?): String = when {
            remainingSeconds == null || remainingSeconds < 0 -> "summary"
            remainingSeconds < 300 -> "short"
            remainingSeconds < 900 -> "summary"
            else -> "full"
        }
    }
}
