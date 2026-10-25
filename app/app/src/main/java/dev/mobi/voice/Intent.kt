package dev.mobi.voice

enum class Intent {
    ACCEPT, DECLINE, SEND, CHANGE, CANCEL, NOT_NOW;

    companion object {
        private val cancel = setOf("취소", "보내지 마", "바꾸지 마")
        private val decline = setOf("됐어", "괜찮아", "조용히", "나중에", "아니", "하지 마", "그만")
        private val accept = setOf("응", "네", "그래", "들려줘")
        private val send = setOf("보내", "보내줘")
        private val change = setOf("바꿔", "바꿔줘")

        fun classify(sentence: String): Intent {
            val normalized = normalize(sentence)
            return when {
                normalized in cancel -> CANCEL
                normalized in decline -> DECLINE
                normalized in accept -> ACCEPT
                normalized in send -> SEND
                normalized in change -> CHANGE
                else -> NOT_NOW
            }
        }

        private fun normalize(sentence: String): String {
            val normalized = java.text.Normalizer.normalize(sentence, java.text.Normalizer.Form.NFC)
                .trim()
                .replace(Regex("\\s+"), " ")
                .trimEnd('.', '!', '?', '．', '！', '？')
                .trim()
            return when (normalized) {
                "하지마" -> "하지 마"
                "보내지마" -> "보내지 마"
                "바꾸지마" -> "바꾸지 마"
                else -> normalized
            }
        }
    }
}
