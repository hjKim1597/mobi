package dev.mobi.voice

import dev.mobi.net.ApiClient
import dev.mobi.net.DeviceCredentials
import dev.mobi.trip.Clock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.ByteArrayOutputStream
import java.net.URL
import java.net.URLConnection
import java.net.URLStreamHandler
import java.net.URLStreamHandlerFactory
import java.net.HttpURLConnection
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class ApiActionGatewayDeadlineTest {
    @Test fun gatewayGetRequestsCarryLongerBudgetAndOrdinaryGetKeepsDefault() {
        val observed = LinkedBlockingQueue<ObservedTimeout>()
        val opened = LinkedBlockingQueue<String>()
        installHttpsFixture(observed, opened)

        val api = ApiClient("https://deadline-fixture.test", clock = Clock { 100L })
        try {
            val gateway = ApiActionGateway(api) { DeviceCredentials("device", "token") }
            val completed = CountDownLatch(4)
            val failures = java.util.concurrent.ConcurrentLinkedQueue<String>()
            fun <T> callback(): (Result<T>) -> Unit = { it.exceptionOrNull()?.let { error -> failures += if (error is dev.mobi.net.ApiFailure) error.code else error.javaClass.simpleName }; completed.countDown() }

            gateway.capabilities(callback())
            gateway.status(UUID.randomUUID().toString(), callback())
            gateway.readback(UUID.randomUUID().toString(), callback())
            api.today(DeviceCredentials("device", "token"), api.deadline(), callback())

            assertTrue("GET requests should reach the fake connection", completed.await(3, TimeUnit.SECONDS))
            val captures = List(4) { observed.poll(1, TimeUnit.SECONDS) ?: error("missing captured request: ${observed.toList()} failures=$failures opened=${opened.toList()}") }
            assertEquals(3, captures.count { it.connectMillis == 9500 && it.readMillis == 9500 })
            assertEquals(1, captures.count { it.connectMillis == 6000 && it.readMillis == 6000 })
            assertTrue(captures.any { it.path == "/v1/capabilities" && it.connectMillis == 9500 })
            assertTrue(captures.any { it.path.startsWith("/v1/actions/") && it.connectMillis == 9500 })
            assertTrue(captures.any { it.path.endsWith("/readback") && it.connectMillis == 9500 })
            assertTrue(captures.any { it.path == "/v1/today" && it.connectMillis == 6000 })
        } finally {
            api.close()
        }
    }

    private data class ObservedTimeout(val path: String, val connectMillis: Int, val readMillis: Int)

    private fun installHttpsFixture(observed: LinkedBlockingQueue<ObservedTimeout>, opened: LinkedBlockingQueue<String>) {
        URL.setURLStreamHandlerFactory(URLStreamHandlerFactory { protocol ->
            if (protocol != "https") null else object : URLStreamHandler() {
                override fun openConnection(url: URL): URLConnection {
                    opened += url.path
                    return object : HttpURLConnection(url) {
                    override fun connect() = Unit
                    override fun disconnect() = Unit
                    override fun usingProxy() = false
                    override fun setReadTimeout(timeout: Int) {
                        super.setReadTimeout(timeout)
                        observed += ObservedTimeout(url.path, connectTimeout, timeout)
                    }
                    override fun getResponseCode(): Int {
                        throw IOException("deadline fixture ends before response decoding")
                    }
                    override fun getOutputStream() = ByteArrayOutputStream()
                    }
                }
            }
        })
    }
}
