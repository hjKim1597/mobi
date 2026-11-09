package dev.mobi.net
import dev.mobi.trip.Clock
import org.junit.Assert.*
import org.junit.Test
class RequestDeadlineTest {
 @Test fun stagesShareOneAbsoluteBudgetAndCancellationClosesIt() {
  var now=100L; val d=RequestDeadline(Clock { now }, 6100)
  now+=300; now+=1700; now+=700; assertEquals(3300L,d.remainingMillis())
  now=6099; assertEquals(1L,d.remainingMillis()); now=6100; assertTrue(d.expired)
  now=100; val c=RequestDeadline(Clock { now },6100); c.cancel(); assertEquals(0L,c.remainingMillis())
 }

 @Test fun apiClientKeepsSixSecondDefaultAndCanCreateLongerActionDeadline() {
  var now = 100L
  ApiClient("https://example.test", clock = Clock { now }).use { api ->
   assertEquals(6100L, api.deadline().expiresAtMillis)
   assertEquals(9600L, api.deadline(9500).expiresAtMillis)
   now = 500L
   assertEquals(6500L, api.deadline(6000).expiresAtMillis)
  }
 }
}
