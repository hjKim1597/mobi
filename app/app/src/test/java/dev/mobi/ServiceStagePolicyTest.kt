package dev.mobi

import org.junit.Assert.*
import org.junit.Test

class ServiceStagePolicyTest {
    @Test fun promotesOnlyForVisiblePermittedLiveApp() {
        assertTrue(ServiceStagePolicy.shouldPromote(visible = true, permissionGranted = true, demo = false))
        assertFalse(ServiceStagePolicy.shouldPromote(visible = false, permissionGranted = true, demo = false))
        assertFalse(ServiceStagePolicy.shouldPromote(visible = true, permissionGranted = false, demo = false))
        assertFalse(ServiceStagePolicy.shouldPromote(visible = true, permissionGranted = true, demo = true))
    }

    @Test fun restoresOnlyOnSameBootWithPermission() {
        assertTrue(ServiceStagePolicy.shouldRestore(currentBoot = 8, promotedBoot = 8, permissionGranted = true))
        assertFalse(ServiceStagePolicy.shouldRestore(currentBoot = 9, promotedBoot = 8, permissionGranted = true))
        assertFalse(ServiceStagePolicy.shouldRestore(currentBoot = 8, promotedBoot = 8, permissionGranted = false))
        assertFalse(ServiceStagePolicy.shouldRestore(currentBoot = null, promotedBoot = 8, permissionGranted = true))
    }
}
