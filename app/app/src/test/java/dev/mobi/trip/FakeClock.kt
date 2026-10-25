package dev.mobi.trip

class FakeClock(var nowMillis: Long = 0L) : Clock {
    override fun elapsedRealtimeMillis(): Long = nowMillis

    fun advanceBy(millis: Long) {
        nowMillis += millis
    }
}
