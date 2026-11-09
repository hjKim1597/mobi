package dev.mobi.voice

import dev.mobi.net.*

/** Uses the existing device auth and longer action-route budget; never retries a POST. */
class ApiActionGateway(private val api: ApiClient, private val credentials: () -> DeviceCredentials?) : ActionGateway {
    private fun actionDeadline() = api.deadline(9500)
    private fun <T> authenticated(cb: (Result<T>)->Unit, call: (DeviceCredentials)->CancelHandle): CancelHandle {
        val c = credentials()
        if (c == null) { cb(Result.failure(ApiFailure(401,"UNAUTHORIZED"))); return CancelHandle {} }
        return call(c)
    }
    override fun capabilities(cb: (Result<Capabilities>)->Unit) = authenticated(cb) { api.capabilities(it,actionDeadline(),cb) }
    override fun scan(tripId: String, quiet: Boolean, cb: (Result<MailScanResponse>)->Unit) = authenticated(cb) { api.scanMail(tripId,it,actionDeadline(),cb,quiet) }
    override fun propose(request: ActionProposalRequest,cb: (Result<ActionProposal>)->Unit) = authenticated(cb) { api.proposeAction(request,it,actionDeadline(),cb) }
    override fun readback(id: String,cb: (Result<ActionProposal>)->Unit) = authenticated(cb) { api.actionReadback(id,it,actionDeadline(),cb) }
    override fun clarify(id: String,version: Int,audio: WavAudio,cb: (Result<ActionProposal>)->Unit) = authenticated(cb) { api.clarifyAction(id,version,audio,it,actionDeadline(),cb) }
    override fun approve(id: String,request: ActionApprovalRequest,cb: (Result<ActionApproval>)->Unit) = authenticated(cb) { api.approveAction(id,request,it,actionDeadline(),cb) }
    override fun cancel(id: String,cb: (Result<ActionCancel>)->Unit) = authenticated(cb) { api.cancelAction(id,it,actionDeadline(),cb) }
    override fun status(id: String,cb: (Result<ActionStatus>)->Unit) = authenticated(cb) { api.actionStatus(id,it,actionDeadline(),cb) }
}
