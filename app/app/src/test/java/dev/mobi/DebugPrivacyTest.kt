package dev.mobi

import org.junit.Assert.assertEquals
import org.junit.Test

class DebugPrivacyTest {
    @Test fun debugLogsOnlyKnownCommandsAndNumericRequestIds() {
        assertEquals("bounds", safeDebugCommand("bounds"))
        assertEquals("unknown", safeDebugCommand("email=private@example.test"))
        assertEquals("123456789", safeDebugRequest("123456789"))
        assertEquals("invalid", safeDebugRequest("calendar title"))
        assertEquals("invalid", safeDebugRequest("123\nsecret"))
    }
}
