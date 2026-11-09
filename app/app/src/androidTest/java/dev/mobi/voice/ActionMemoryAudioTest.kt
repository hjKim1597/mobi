package dev.mobi.voice

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ActionMemoryAudioTest {
    @Test fun sourceSupportsSeekEofAndZeroesAudioOnClose() {
        val bytes = byteArrayOf(1,2,3,4)
        val source = ActionMemorySource(bytes)
        val target = ByteArray(4)
        assertEquals(2,source.readAt(2,target,1,3)); assertArrayEquals(byteArrayOf(0,3,4,0),target)
        assertEquals(-1,source.readAt(4,target,0,1))
        source.close(); assertTrue(bytes.all { it == 0.toByte() })
        assertEquals(-1,source.readAt(0,target,0,1))
    }
}
