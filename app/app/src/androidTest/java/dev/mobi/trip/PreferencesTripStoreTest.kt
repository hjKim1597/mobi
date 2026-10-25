package dev.mobi.trip

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mobi.vehicle.Gear
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PreferencesTripStoreTest {
    @Test
    fun snapshotSurvivesStoreReopenWithAllRecoveryFields() {
        val prefs = preferences()
        prefs.edit().clear().commit()
        val expected = TripSnapshot(
            schemaVersion = 1,
            bootCount = 42,
            tripId = 9,
            gear = Gear.PARK,
            parkedAtMillis = 123_456,
            firstDeparturePending = false,
            knockConsumed = true,
            muted = true,
            dialogTerminal = "MUTED",
        )

        assertTrue(PreferencesTripStore(prefs).save(expected))

        assertEquals(expected, PreferencesTripStore(preferences()).load())
    }

    @Test
    fun missingOrUnknownSchemaDoesNotProduceAUsableSnapshot() {
        val prefs = preferences()
        prefs.edit().clear().commit()
        assertNull(PreferencesTripStore(prefs).load())

        prefs.edit().putInt("schemaVersion", 999).commit()
        assertTrue(PreferencesTripStore(preferences()).load()!!.schemaVersion != 1)
        assertTrue("unknown schema remains untouched", preferences().contains("schemaVersion"))
    }

    @Test
    fun storedSnapshotContainsNoTranscriptOrPermissionMaterial() {
        val prefs = preferences()
        prefs.edit().clear().commit()
        assertTrue(PreferencesTripStore(prefs).save(TripSnapshot(bootCount = 1, tripId = 2)))

        val keys = preferences().all.keys
        assertFalse(keys.any { it.contains("transcript", ignoreCase = true) })
        assertFalse(keys.any { it.contains("token", ignoreCase = true) })
        assertFalse(keys.any { it.contains("permission", ignoreCase = true) })
        assertFalse(keys.any { it.contains("audio", ignoreCase = true) })
    }

    @Test
    fun missingRequiredFieldFailsClosedInsteadOfUsingAFalseDefault() {
        val prefs = preferences()
        prefs.edit().clear().commit()
        assertTrue(PreferencesTripStore(prefs).save(TripSnapshot(bootCount = 5, tripId = 3)))
        prefs.edit().remove("muted").commit()

        val loaded = PreferencesTripStore(preferences()).load()

        assertTrue(loaded!!.schemaVersion != 1)
    }

    private fun preferences() =
        ApplicationProvider.getApplicationContext<Context>()
            .getSharedPreferences("trip_store_test", Context.MODE_PRIVATE)
}
