package dev.mobi.vehicle
import org.junit.Assert.*
import org.junit.Test
class NaviSourceTest {
 @Test fun secondsAndMissingRouteAreDistinct() {
  listOf(0,180,299).forEach{assertEquals("short",NaviSource.bucket(it))}
  listOf(300,600,899,null).forEach{assertEquals("summary",NaviSource.bucket(it))}
  listOf(900,1800).forEach{assertEquals("full",NaviSource.bucket(it))}
  assertNull(NaviSource.seconds(-1)); assertEquals(0,NaviSource.seconds(0))
 }
}
