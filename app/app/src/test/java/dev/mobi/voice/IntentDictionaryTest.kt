package dev.mobi.voice

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class IntentDictionaryTest(private val sentence: String, private val expected: Intent) {
    @Test fun classifiesWholeSentence() {
        assertEquals(sentence, expected, Intent.classify(sentence))
    }

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{index}: {0} -> {1}")
        fun cases() = listOf(
            row("응", Intent.ACCEPT), row("네", Intent.ACCEPT), row("그래", Intent.ACCEPT),
            row("들려줘", Intent.ACCEPT), row(" 응 ", Intent.ACCEPT), row("네.", Intent.ACCEPT),
            row("그래!", Intent.ACCEPT), row("들려줘?", Intent.ACCEPT), row("됐어", Intent.DECLINE),
            row("괜찮아", Intent.DECLINE), row("조용히", Intent.DECLINE), row("나중에", Intent.DECLINE),
            row("아니", Intent.DECLINE), row("하지 마", Intent.DECLINE), row("그만", Intent.DECLINE),
            row("하지마", Intent.DECLINE), row("  됐어!  ", Intent.DECLINE), row("괜찮아.", Intent.DECLINE),
            row("조용히!", Intent.DECLINE), row("나중에.", Intent.DECLINE), row("아니!", Intent.DECLINE),
            row("하지  마", Intent.DECLINE), row("보내", Intent.SEND), row("보내줘", Intent.SEND),
            row("보내.", Intent.SEND), row(" 보내줘! ", Intent.SEND), row("바꿔", Intent.CHANGE),
            row("바꿔줘", Intent.CHANGE), row("바꿔.", Intent.CHANGE), row("바꿔줘! ", Intent.CHANGE),
            row("취소", Intent.CANCEL), row("보내지 마", Intent.CANCEL), row("바꾸지 마", Intent.CANCEL),
            row("보내지마", Intent.CANCEL), row("바꾸지마", Intent.CANCEL), row(" 취소! ", Intent.CANCEL),
            row("보내지  마.", Intent.CANCEL), row("바꾸지\t마", Intent.CANCEL), row("말해줘", Intent.NOT_NOW),
            row("안내해줘", Intent.NOT_NOW), row("마지막 메일", Intent.NOT_NOW),
            row("오늘 일정 알려줘", Intent.NOT_NOW), row("", Intent.NOT_NOW), row(" \t\n ", Intent.NOT_NOW),
            row("음", Intent.NOT_NOW), row("아마", Intent.NOT_NOW), row("응 보내", Intent.NOT_NOW),
            row("네 바꿔줘", Intent.NOT_NOW), row("보내지 말고 읽어줘", Intent.NOT_NOW),
            row("바꾸지 말아줘", Intent.NOT_NOW), row("아니 보내줘", Intent.NOT_NOW),
            row("보내줘 아니", Intent.NOT_NOW), row("취소하고 보내", Intent.NOT_NOW),
            row("보내도 돼?", Intent.NOT_NOW), row("안 보내", Intent.NOT_NOW), row("안 바꿔", Intent.NOT_NOW),
            row("그만큼 알려줘", Intent.NOT_NOW), row("나중에 일정 알려줘", Intent.NOT_NOW),
            row("아니면 알려줘", Intent.NOT_NOW), row("보내. 취소.", Intent.NOT_NOW),
        )

        private fun row(sentence: String, intent: Intent) = arrayOf(sentence, intent)
    }
}

class IntentUnicodeNormalizationTest {
    @Test fun normalizesNfcAndFullWidthSentenceEnding() {
        assertEquals(Intent.ACCEPT, Intent.classify("네！"))
        assertEquals(Intent.DECLINE, Intent.classify("됐어．"))
    }

    @Test fun punctuationInsideSentenceDoesNotMergeCommands() {
        assertEquals(Intent.NOT_NOW, Intent.classify("보내. 취소."))
    }
}

class IntentNoiseSafetyTest {
    @org.junit.Test fun fiftyNoiseNegativeAndMixedSentencesNeverAuthorizeWrites() {
        val base=listOf("", " ", "음악", "자막 제공", "시청해 주셔서 감사합니다", "보네", "아쿠어", "보내지 마", "바꾸지 마", "응 보내")
        val samples=base+List(40){"잡음 $it 보내 아니"}
        org.junit.Assert.assertEquals(50,samples.size)
        samples.forEach { org.junit.Assert.assertFalse(Intent.classify(it) in setOf(Intent.SEND,Intent.CHANGE)) }
    }
}
