package dev.mobi.dialog

/** Ephemeral, display-safe action content supplied by the action session. */
data class ActionView(
    val stage: String,
    val kind: String,
    val title: String,
    val detail: String,
    val canReply: Boolean = false,
    val canAddCalendar: Boolean = false,
    val readbackFinished: Boolean = false,
    val demo: Boolean = false,
    val identity: String? = null,
)
