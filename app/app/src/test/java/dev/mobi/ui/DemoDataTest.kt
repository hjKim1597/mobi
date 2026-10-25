package dev.mobi.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoDataTest {
    @Test
    fun repeatedAcceptDoesNotRestartAnActiveOrCompletedBriefing() {
        val session = DemoSession()
        assertTrue(session.accept())
        session.next()
        assertFalse(session.accept())
        assertEquals(DemoData.briefings[1], session.current)
        session.next()
        session.next()
        assertFalse(session.accept())
        assertTrue(session.isComplete)
        assertNull(session.current)
        session.reset()
        assertTrue(session.accept())
        assertEquals(DemoData.briefings.first(), session.current)
    }

    @Test
    fun fixtureHasThreeAnonymousFixedBriefingsInOrder() {
        assertEquals(3, DemoData.briefings.size)
        assertEquals(listOf("하늘", "도담", "새봄"), DemoData.briefings.map { it.name })
        assertEquals(DemoData.briefings, DemoData.briefings.toList())
        DemoData.briefings.forEach { briefing ->
            assertFalse(briefing.name.contains('@'))
            assertFalse(briefing.title.contains("http", ignoreCase = true))
            assertFalse(briefing.title.contains("www.", ignoreCase = true))
        }
    }

    @Test
    fun acceptedSessionShowsThreeCardsThenCompletesAndCanReset() {
        val session = DemoSession()

        assertNull(session.current)
        assertTrue(session.accept())
        assertEquals(DemoData.briefings[0], session.current)
        assertFalse(session.isComplete)

        assertTrue(session.next())
        assertEquals(DemoData.briefings[1], session.current)
        assertTrue(session.next())
        assertEquals(DemoData.briefings[2], session.current)
        assertFalse(session.next())
        assertTrue(session.isComplete)
        assertNull(session.current)

        session.reset()
        assertFalse(session.isComplete)
        assertNull(session.current)
        assertTrue(session.accept())
        assertEquals(DemoData.briefings[0], session.current)
    }

    @Test
    fun resetDoesNotChangeIndependentLiveMuteState() {
        var liveMuted = true
        val session = DemoSession()
        session.accept()
        session.next()

        session.reset()

        assertTrue(liveMuted)
        assertNull(session.current)
        liveMuted = false
        assertFalse(liveMuted)
        assertNull(session.current)
    }
}
