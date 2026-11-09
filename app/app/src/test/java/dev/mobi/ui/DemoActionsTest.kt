package dev.mobi.ui

import org.junit.Assert.assertTrue
import org.junit.Test

class DemoActionsTest {
    @Test fun fixedFixturesAreClearlyLocalAndContainNoAccountIdentifiers() {
        assertTrue(DemoActions.offerSentences.endsWith("회신 내용을 작성할까요?"))
        assertTrue(DemoActions.calendarOffer.endsWith("일정 내용을 확인할까요?"))
        assertTrue(DemoActions.mailTitle.contains("가상"))
        assertTrue(DemoActions.mailDetail.contains("가상 담당자"))
        assertTrue(DemoActions.replyReadback.contains(DemoActions.replyText))
        assertTrue(DemoActions.replyReadback.contains("‘보내’"))
        assertTrue(DemoActions.calendarReadback.contains("2026년 11월 10일"))
        assertTrue(DemoActions.calendarReadback.contains("‘추가해’"))
        assertTrue(DemoActions.replyResult.contains("실제 메일은 보내지 않았어요"))
        assertTrue(DemoActions.calendarResult.contains("실제 일정은 만들지 않았어요"))
        listOf(DemoActions.mailTitle, DemoActions.mailDetail, DemoActions.replyText,
            DemoActions.replyReadback, DemoActions.calendarReadback, DemoActions.replyResult,
            DemoActions.calendarResult, DemoActions.holdReply, DemoActions.holdCalendar).forEach { text ->
            assertTrue(text.none { it == '@' })
            assertTrue(!text.contains("http", ignoreCase = true))
        }
    }
}
