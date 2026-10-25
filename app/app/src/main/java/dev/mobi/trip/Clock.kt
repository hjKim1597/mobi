package dev.mobi.trip

fun interface Clock {
    fun elapsedRealtimeMillis(): Long
}
