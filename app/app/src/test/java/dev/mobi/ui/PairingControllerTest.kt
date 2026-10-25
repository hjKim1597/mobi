package dev.mobi.ui
import dev.mobi.net.*
import dev.mobi.trip.Clock
import org.junit.Assert.*
import org.junit.Test
class PairingControllerTest {
 @Test fun registration429BlocksRetryUntilRetryAfterHasElapsed() {
  var now=0L;var registers=0;var callback:((Result<DeviceCredentials>)->Unit)?=null;var view=PairingView()
  val c=PairingController(Clock{now},{0L},{null},{_,cb->registers++;callback=cb;CancelHandle{}},{},
   {_,_,_->CancelHandle{}},{_,_,_,_->CancelHandle{}},{_,_->CancelHandle{}},{view=it})

  c.begin();callback!!(Result.failure(ApiFailure(429,"RATE_LIMITED",3)))
  assertEquals("failed",view.status)
  c.begin();assertEquals(1,registers)
  now=2999;c.begin();assertEquals(1,registers)
  now=3000;c.begin();assertEquals(2,registers)
 }

 @Test fun expiredPairingPollFinishesAndClearsTheQr() {
  var now=0L;val tasks=mutableListOf<Pair<Long,()->Unit>>();var pollCallback:((Result<PairingStatus>)->Unit)?=null;var view=PairingView()
  val c=PairingController(Clock{now},{0L},{DeviceCredentials("id","token")},{_,_->error("register")},{},
   {_,_,cb->cb(Result.success(PairingCreated("code","https://example.test/pair/code","1970-01-01T00:05:00Z")));CancelHandle{}},
   {_,_,_,cb->pollCallback=cb;CancelHandle{}},
   {ms,fn->tasks+=now+ms to fn;CancelHandle{tasks.removeAll{it.second===fn}}},{view=it})

  c.begin()
  assertEquals("pending",view.status)
  now=2000;tasks.filter{it.first<=now}.toList().forEach{tasks.remove(it);it.second()}
  pollCallback!!(Result.failure(ApiFailure(410,"PAIRING_EXPIRED")))
  assertEquals("expired",view.status)
  assertNull(view.url)
 }

 @Test fun processingStatusRemainsVisibleAndPollsAgainUntilExpiry() {
  var now=0L;val tasks=mutableListOf<Pair<Long,()->Unit>>();var polls=0;var pollCallback:((Result<PairingStatus>)->Unit)?=null
  var view=PairingView()
  val c=PairingController(Clock{now},{0L},{DeviceCredentials("id","token")},{_,_->error("register")},{},
   {_,_,cb->cb(Result.success(PairingCreated("code","https://example.test/pair/code","1970-01-01T00:00:05Z")));CancelHandle{}},
   {_,_,_,cb->polls++;pollCallback=cb;CancelHandle{}},
   {ms,fn->tasks+=now+ms to fn;CancelHandle{tasks.removeAll{it.second===fn}}},{view=it})
  fun advance(ms:Long) { now+=ms;tasks.filter{it.first<=now}.toList().forEach{tasks.remove(it);it.second()} }

  c.begin();advance(2000)
  pollCallback!!(Result.success(PairingStatus("processing","1970-01-01T00:00:05Z")))
  assertEquals("processing",view.status);assertNotNull(view.url)
  advance(2000);assertEquals(2,polls)
  pollCallback!!(Result.success(PairingStatus("processing","1970-01-01T00:00:05Z")))
  advance(1000)
  assertEquals("expired",view.status);assertNull(view.url)
  advance(2000);assertEquals(2,polls)
 }

 @Test fun pollsOnceEveryTwoSecondsAndIgnoresCancelledAttempt() {
  var now=0L; val tasks=mutableListOf<Pair<Long,()->Unit>>(); var creates=0; var polls=0
  var createCallback:((Result<PairingCreated>)->Unit)?=null
  var view=PairingView()
  val c=PairingController(Clock{now},{0L},{DeviceCredentials("id","token")},{_,_->error("register")},{},
   {_,_,cb->creates++;createCallback=cb;CancelHandle{}},
   {_,_,_,cb->polls++;cb(Result.success(PairingStatus("pending","1970-01-01T00:05:00Z")));CancelHandle{}},
   {ms,fn->tasks+=now+ms to fn;CancelHandle{tasks.removeAll{it.second===fn}}},{view=it})
  c.begin(); c.begin(); assertEquals(1,creates)
  createCallback!!(Result.success(PairingCreated("A".repeat(43),"https://example.test/pair/"+"A".repeat(43),"1970-01-01T00:05:00Z")))
  assertEquals("pending",view.status); assertEquals(0,polls)
  now=2000; tasks.filter{it.first<=now}.toList().forEach{tasks.remove(it);it.second()};assertEquals(1,polls)
  c.cancel(); assertNull(view.url); now=300000; tasks.toList().forEach{it.second()};assertEquals(1,polls)
 }
 @Test fun unsafeLateRegistrationCannotCreateQr() {
  var cb:((Result<DeviceCredentials>)->Unit)?=null;var saved=0;var created=0
  val c=PairingController(Clock{0},{0},{null},{_,f->cb=f;CancelHandle{}},{saved++},
   {_,_,_->created++;CancelHandle{}},{_,_,_,_->CancelHandle{}},{_,_->CancelHandle{}},{})
  c.begin();c.cancel();cb!!(Result.success(DeviceCredentials("id","token")))
  assertEquals(0,saved);assertEquals(0,created)
 }
}
