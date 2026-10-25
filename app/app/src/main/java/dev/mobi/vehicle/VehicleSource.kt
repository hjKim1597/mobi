package dev.mobi.vehicle

import android.car.Car
import android.car.VehicleGear
import android.car.VehiclePropertyIds
import android.car.drivingstate.CarUxRestrictionsManager
import android.car.hardware.CarPropertyValue
import android.car.hardware.property.CarPropertyManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

/** One service-owned connection. Unknown or lost signals always close interaction. */
class VehicleSource(private val context: Context, private val changed: (VehicleSnapshot) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var car: Car? = null
    private var ux: CarUxRestrictionsManager? = null
    private var properties: CarPropertyManager? = null
    private var snapshot = VehicleSnapshot()
    private var closed = false
    private var latestGearTimestamp = -1L
    private val callback = object : CarPropertyManager.CarPropertyEventCallback {
        override fun onChangeEvent(value: CarPropertyValue<*>?) {
            if (closed || value?.propertyId != VehiclePropertyIds.GEAR_SELECTION) return
            if (value.status != CarPropertyValue.STATUS_AVAILABLE) {
                publish(snapshot.copy(gear = Gear.UNKNOWN, sourceTimestampNanos = value.timestamp))
                return
            }
            if (value.timestamp <= latestGearTimestamp) return
            latestGearTimestamp = value.timestamp
            val gear = when (value.value as? Int) {
                VehicleGear.GEAR_PARK -> Gear.PARK
                VehicleGear.GEAR_DRIVE -> Gear.DRIVE
                VehicleGear.GEAR_REVERSE -> Gear.REVERSE
                VehicleGear.GEAR_NEUTRAL -> Gear.NEUTRAL
                else -> Gear.UNKNOWN
            }
            publish(snapshot.copy(gear = gear, sourceTimestampNanos = value.timestamp))
        }
        override fun onErrorEvent(propertyId: Int, areaId: Int) {
            if (propertyId == VehiclePropertyIds.GEAR_SELECTION) publish(snapshot.copy(gear = Gear.UNKNOWN))
        }
    }

    fun start() {
        car = Car.createCar(context, main, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connected, ready ->
            if (closed) return@createCar
            if (!ready) {
                ux = null
                properties = null
                latestGearTimestamp = -1L
                publish(VehicleSnapshot())
                return@createCar
            }
            try {
                ux = connected.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as CarUxRestrictionsManager
                properties = connected.getCarManager(Car.PROPERTY_SERVICE) as CarPropertyManager
                publish(snapshot.copy(available = true))
                ux!!.registerListener { restrictions ->
                    publish(snapshot.copy(
                        uxKnown = true,
                        restricted = restrictions.isRequiresDistractionOptimization || restrictions.activeRestrictions != 0,
                    ))
                }
                val restrictions = ux!!.currentCarUxRestrictions
                publish(snapshot.copy(
                    uxKnown = restrictions != null,
                    restricted = restrictions == null || restrictions.isRequiresDistractionOptimization || restrictions.activeRestrictions != 0,
                ))
                check(properties!!.registerCallback(callback, VehiclePropertyIds.GEAR_SELECTION, CarPropertyManager.SENSOR_RATE_ONCHANGE))
                callback.onChangeEvent(properties!!.getProperty<Int>(VehiclePropertyIds.GEAR_SELECTION, 0))
            } catch (failure: Exception) {
                Log.w("Mobi", "VEHICLE_UNAVAILABLE reason=${failure.javaClass.simpleName}")
                publish(VehicleSnapshot())
            }
        }
    }

    private fun publish(value: VehicleSnapshot) {
        if (closed) return
        snapshot = value
        changed(value)
    }

    fun close() {
        closed = true
        runCatching { ux?.unregisterListener() }
        runCatching { properties?.unregisterCallback(callback) }
        car?.disconnect()
        main.removeCallbacksAndMessages(null)
    }
}
