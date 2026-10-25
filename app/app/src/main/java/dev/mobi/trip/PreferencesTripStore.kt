package dev.mobi.trip

import android.content.SharedPreferences

class PreferencesTripStore(private val preferences: SharedPreferences) : TripStore {
    override fun load(): TripSnapshot? {
        if (!preferences.contains(KEY_SCHEMA)) return null

        return try {
            val schema = preferences.getInt(KEY_SCHEMA, INVALID_SCHEMA)
            if (schema != CURRENT_SCHEMA || REQUIRED_KEYS.any { !preferences.contains(it) }) {
                return invalidSnapshot()
            }

            val gearName = preferences.getString(KEY_GEAR, null) ?: return invalidSnapshot()
            val gear = dev.mobi.vehicle.Gear.entries.firstOrNull { it.name == gearName }
                ?: return invalidSnapshot()
            val bootCount = preferences.getInt(KEY_BOOT_COUNT, INVALID_INT)
            val tripId = preferences.getLong(KEY_TRIP_ID, INVALID_LONG)
            val firstDeparturePending = preferences.getBoolean(KEY_FIRST_DEPARTURE, false)
            val knockConsumed = preferences.getBoolean(KEY_KNOCK_CONSUMED, false)
            val muted = preferences.getBoolean(KEY_MUTED, false)
            val dialogTerminal = preferences.getString(KEY_DIALOG_TERMINAL, null)
                ?: return invalidSnapshot()
            if (bootCount < 0 || tripId < 0) return invalidSnapshot()

            val parkedAtMillis = if (preferences.contains(KEY_PARKED_AT)) {
                preferences.getLong(KEY_PARKED_AT, INVALID_LONG).takeIf { it >= 0 }
                    ?: return invalidSnapshot()
            } else null
            if ((gear == dev.mobi.vehicle.Gear.PARK) != (parkedAtMillis != null)) {
                return invalidSnapshot()
            }

            TripSnapshot(
                schemaVersion = schema,
                bootCount = bootCount,
                tripId = tripId,
                gear = gear,
                parkedAtMillis = parkedAtMillis,
                firstDeparturePending = firstDeparturePending,
                knockConsumed = knockConsumed,
                muted = muted,
                dialogTerminal = dialogTerminal,
            )
        } catch (_: ClassCastException) {
            invalidSnapshot()
        }
    }

    override fun save(snapshot: TripSnapshot): Boolean {
        if (snapshot.schemaVersion != CURRENT_SCHEMA || snapshot.bootCount < 0 || snapshot.tripId < 0 ||
            snapshot.parkedAtMillis?.let { it < 0 } == true ||
            ((snapshot.gear == dev.mobi.vehicle.Gear.PARK) != (snapshot.parkedAtMillis != null))
        ) {
            return false
        }
        return preferences.edit()
            .putInt(KEY_SCHEMA, snapshot.schemaVersion)
            .putInt(KEY_BOOT_COUNT, snapshot.bootCount)
            .putLong(KEY_TRIP_ID, snapshot.tripId)
            .putString(KEY_GEAR, snapshot.gear.name)
            .apply {
                if (snapshot.parkedAtMillis == null) remove(KEY_PARKED_AT)
                else putLong(KEY_PARKED_AT, snapshot.parkedAtMillis)
            }
            .putBoolean(KEY_FIRST_DEPARTURE, snapshot.firstDeparturePending)
            .putBoolean(KEY_KNOCK_CONSUMED, snapshot.knockConsumed)
            .putBoolean(KEY_MUTED, snapshot.muted)
            .putString(KEY_DIALOG_TERMINAL, snapshot.dialogTerminal)
            .commit()
    }

    private fun invalidSnapshot() = TripSnapshot(
        schemaVersion = INVALID_SCHEMA,
        bootCount = -1,
        knockConsumed = true,
    )

    private companion object {
        const val CURRENT_SCHEMA = 1
        const val INVALID_SCHEMA = Int.MIN_VALUE
        const val INVALID_INT = Int.MIN_VALUE
        const val INVALID_LONG = Long.MIN_VALUE
        const val KEY_SCHEMA = "schemaVersion"
        const val KEY_BOOT_COUNT = "bootCount"
        const val KEY_TRIP_ID = "tripId"
        const val KEY_GEAR = "gear"
        const val KEY_PARKED_AT = "parkedAtMillis"
        const val KEY_FIRST_DEPARTURE = "firstDeparturePending"
        const val KEY_KNOCK_CONSUMED = "knockConsumed"
        const val KEY_MUTED = "muted"
        const val KEY_DIALOG_TERMINAL = "dialogTerminal"
        val REQUIRED_KEYS = setOf(
            KEY_SCHEMA,
            KEY_BOOT_COUNT,
            KEY_TRIP_ID,
            KEY_GEAR,
            KEY_FIRST_DEPARTURE,
            KEY_KNOCK_CONSUMED,
            KEY_MUTED,
            KEY_DIALOG_TERMINAL,
        )
    }
}
