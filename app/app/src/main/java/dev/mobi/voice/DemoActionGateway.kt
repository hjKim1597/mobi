package dev.mobi.voice

import dev.mobi.net.*
import dev.mobi.ui.DemoActions
import java.util.UUID

/** Local-only provider, deliberately has no ApiClient, credentials, or microphone dependency. */
class DemoActionGateway(private val audio: (String)->WavAudio?, private val now: ()->Long = System::currentTimeMillis) : ActionGateway {
    constructor(assets: ActionAudioAssets) : this(assets::get)
    private data class Row(val proposal: ActionProposal,val kind: String,var status: String="awaiting_approval",var executeAt: Long=0)
    private val rows = mutableMapOf<String,Row>()
    private fun sentence(text: String,key: String) = listOf(Sentence(text,requireNotNull(audio(key))))
    private fun <T> respond(value: T,cb: (Result<T>)->Unit): CancelHandle { cb(Result.success(value)); return CancelHandle {} }
    override fun capabilities(cb: (Result<Capabilities>)->Unit) = respond(Capabilities(true,true,true,true,false),cb)
    override fun scan(tripId: String, quiet: Boolean, cb: (Result<MailScanResponse>)->Unit) = respond(if (quiet) MailScanResponse(null) else MailScanResponse(MailCandidate("demo-mail",false,true,true,
        sentence(DemoActions.offerSentences,"demo_mail"),
        sentence(DemoActions.replyPrompt,"demo_prompt"),
        sentence(DemoActions.calendarOffer,"demo_calendar_offer"),
        ActionDisplay(sender="가상 담당자",subject=DemoActions.mailTitle,summary=DemoActions.mailDetail))),cb)
    override fun propose(request: ActionProposalRequest,cb: (Result<ActionProposal>)->Unit): CancelHandle {
        require(request.tripId.startsWith("demo-"))
        val calendar=request.kind=="calendar_insert"
        val proposal=ActionProposal(UUID.randomUUID().toString(),1,"awaiting_approval","demo-content",
            sentence(if(calendar) DemoActions.calendarReadback else DemoActions.replyReadback,if(calendar) "demo_calendar" else "demo_reply"),
            if(calendar) ActionDisplay(title="회의 시간 확인",start="2026-11-10T14:00:00+09:00",end="2026-11-10T14:30:00+09:00",timeZone="Asia/Seoul")
            else ActionDisplay(sender="가상 담당자",subject=DemoActions.mailTitle,body=DemoActions.replyText),now()+90000,null)
        rows[proposal.actionId]=Row(proposal,request.kind)
        return respond(proposal,cb)
    }
    override fun readback(id: String, cb: (Result<ActionProposal>) -> Unit): CancelHandle {
        val proposal = rows[id]?.proposal
        if (proposal == null) cb(Result.failure(IllegalStateException("No demo readback"))) else cb(Result.success(proposal))
        return CancelHandle {}
    }
    override fun clarify(id: String,version: Int,audio: WavAudio,cb: (Result<ActionProposal>)->Unit): CancelHandle {
        cb(Result.failure(IllegalStateException("No ambiguous demo dates")));return CancelHandle {}
    }
    override fun approve(id: String,request: ActionApprovalRequest,cb: (Result<ActionApproval>)->Unit): CancelHandle {
        val row=rows.getValue(id)
        require(row.status=="awaiting_approval" && request.version==row.proposal.version && request.contentHash==row.proposal.contentHash)
        row.status="holding"
        val calendar=row.kind=="calendar_insert"
        val hold=sentence(if(calendar) DemoActions.holdCalendar else DemoActions.holdReply,if(calendar) "demo_hold_calendar" else "demo_hold_reply")
        val bytes=hold.single().audio.bytes()
        val buffer=java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        // The fixed local WAV has one mono PCM data chunk; reserve ten full seconds after its speech.
        val duration=(bytes.size-44)*1000L/buffer.getInt(28).coerceAtLeast(1)
        bytes.fill(0)
        val start=now(); row.executeAt=start+maxOf(12000,duration+10250)
        return respond(ActionApproval(id,"holding",row.executeAt,start,hold,null,null),cb)
    }
    override fun cancel(id: String,cb: (Result<ActionCancel>)->Unit): CancelHandle {
        val row=rows.getValue(id)
        if(row.status in setOf("awaiting_approval","holding")) row.status="cancelled"
        return respond(ActionCancel(id,row.status,row.status=="cancelled"),cb)
    }
    override fun status(id: String,cb: (Result<ActionStatus>)->Unit): CancelHandle {
        val row=rows.getValue(id)
        if(row.status=="holding" && now()>=row.executeAt) row.status="succeeded"
        val speech=when(row.status) {
            "succeeded" -> if(row.kind=="mail_reply") sentence(DemoActions.replyResult,"demo_reply_result") else sentence(DemoActions.calendarResult,"demo_calendar_result")
            "cancelled" -> if (row.kind=="mail_reply") sentence("보내지 않았어요.","not_written_reply") else sentence("일정을 추가하지 않았어요.","not_written_calendar")
            else -> null
        }
        return respond(ActionStatus(id,row.kind,row.status,row.executeAt,null,speech),cb)
    }
}
