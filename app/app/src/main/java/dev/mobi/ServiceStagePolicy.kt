package dev.mobi

object ServiceStagePolicy {
    fun shouldPromote(visible: Boolean, permissionGranted: Boolean, demo: Boolean): Boolean =
        visible && permissionGranted && !demo

    fun shouldRestore(currentBoot: Int?, promotedBoot: Int, permissionGranted: Boolean): Boolean =
        currentBoot != null && currentBoot == promotedBoot && permissionGranted
}
