package dev.mobi.ui

/** Static, local-only demo content. It contains no accounts, contacts, or external links. */
data class DemoBriefing(
    val name: String,
    val title: String,
    val detail: String,
)

object DemoData {
    val briefings: List<DemoBriefing> = listOf(
        DemoBriefing("하늘", "오전 일정", "데모 일정 · 오전 9시, 팀 회의"),
        DemoBriefing("도담", "이동 안내", "데모 일정 · 오전 11시, 시청 방문"),
        DemoBriefing("새봄", "오늘의 메모", "데모 일정 · 오후 2시, 자료 확인"),
    )
}

/** Minimal session API used by the screen to keep demo progress separate from live state. */
class DemoSession {
    private var index: Int = -1
    val current: DemoBriefing?
        get() = DemoData.briefings.getOrNull(index)
    val isComplete: Boolean
        get() = index >= DemoData.briefings.size

    fun accept(): Boolean {
        if (index != -1) return false
        index = 0
        return true
    }

    fun next(): Boolean {
        if (index !in DemoData.briefings.indices) return false
        index++
        return index < DemoData.briefings.size
    }

    fun reset() {
        index = -1
    }
}
