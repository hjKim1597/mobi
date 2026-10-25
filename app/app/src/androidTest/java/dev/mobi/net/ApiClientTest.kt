package dev.mobi.net

import androidx.test.platform.app.InstrumentationRegistry
import dev.mobi.trip.Clock
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ApiClientTest {
    companion object {
        const val BASE = "http://127.0.0.1:8788"
        fun config(value: String) {
            val c=URL("$BASE/__test/config").openConnection() as HttpURLConnection
            c.requestMethod="POST";c.doOutput=true;c.setRequestProperty("Content-Type","application/json")
            c.outputStream.use{it.write(value.toByteArray())};check(c.responseCode==200);c.disconnect()
        }
        fun <T> await(start: ((Result<T>)->Unit)->CancelHandle): Result<T> {
            val latch=CountDownLatch(1);var value:Result<T>?=null
            start{value=it;latch.countDown()};check(latch.await(8,TimeUnit.SECONDS));return value!!
        }
    }
    @Test fun exactContractAuthenticationAndUnknownFields() {
        config("{}")
        ApiClient(BASE,true).use { api ->
            val d=await<DeviceCredentials>{api.register(api.deadline(),it)}.getOrThrow()
            assertEquals(36,d.deviceId.length)
            val pair=await<PairingCreated>{api.createPairing(d,api.deadline(),it)}.getOrThrow()
            assertTrue(pair.pairingUrl.endsWith(pair.code))
            val today=await<TodayResponse>{api.today(d,api.deadline(),it)}.getOrThrow()
            assertEquals(3,today.events.size);assertEquals(3,today.knock.eventCount)
            for ((seconds,bucket) in listOf(180 to "short",600 to "summary",1800 to "full",null to "summary")) {
                val b=await<BriefingResponse>{api.briefing(BriefingRequest("1",seconds),d,api.deadline(),it)}.getOrThrow()
                assertEquals(bucket,b.bucket)
                val expected=when(bucket){"short"->1;"summary"->2;else->4}
                assertEquals(expected,b.text.split('.').count{it.isNotBlank()})
            }
        }
    }
    @Test fun malformedAndErrorResponsesAreNotPlayback() {
        ApiClient(BASE,true).use { api ->
            for (status in listOf(401,403,429,502)) {
                config("{\"status\":$status}")
                val r=await<TodayResponse>{api.today(DeviceCredentials("id","test"),api.deadline(),it)}
                assertEquals(status,(r.exceptionOrNull() as ApiFailure).status)
            }
            config("{\"badAudio\":true}")
            assertTrue(await<TodayResponse>{api.today(DeviceCredentials("id","test"),api.deadline(),it)}.isFailure)
        }
        config("{}")
    }
    @Test fun slowDripHasOneWallClockDeadlineAndCancelDiscardsLateResult() {
        config("{\"drip\":true}")
        ApiClient(BASE,true).use { api ->
            val credential=await<DeviceCredentials>{api.register(api.deadline(),it)}.getOrThrow()
            val start=android.os.SystemClock.elapsedRealtime()
            val r=await<TodayResponse>{api.today(credential,api.deadline(),it)}
            val duration=android.os.SystemClock.elapsedRealtime()-start
            assertTrue(r.isFailure);assertTrue("deadline=$duration",duration in 5500..6500)
        }
        config("{}")
    }
    @Test fun malformedConfirmLabelIsRejected() {
        val response=JSONObject("""{"transcript":"응","match":{"label":"OUTSIDE_CLOSED_SET","action":"LISTEN","mode":"exact"}}""")
        assertTrue("Unknown match label must fail decoding",runCatching { ApiContract.confirm(response) }.isFailure)
        for (label in listOf("", "none", "NONE ", "하지마", "새로운 문장")) {
            response.getJSONObject("match").put("label",label)
            assertTrue(runCatching { ApiContract.confirm(response) }.isFailure)
        }
    }
    @Test fun everyFrozenConfirmLabelAndNoneDecodeWithoutChangingTheLocalIntentPolicy() {
        val labels=listOf("응", "네", "됐어", "보내", "취소", "하지 마", "아니", "그래", "들려줘", "나중에",
            "조용히", "그만", "괜찮아", "보내줘", "바꿔", "바꿔줘", "보내지 마", "바꾸지 마", "말해줘", "안내해줘", "NONE")
        for (label in labels) {
            val response=JSONObject().put("transcript",label).put("match",JSONObject()
                .put("label",label).put("action",if(label=="NONE") "NOT_NOW" else "LISTEN")
                .put("mode",if(label=="NONE") "none" else "exact"))
            assertEquals(label,ApiContract.confirm(response).match.label)
        }
        assertEquals(dev.mobi.voice.Intent.NOT_NOW,dev.mobi.voice.Intent.classify("말해줘"))
        assertEquals(dev.mobi.voice.Intent.NOT_NOW,dev.mobi.voice.Intent.classify("안내해줘"))
    }
    @Test fun invalidRequiredFieldsAndRiffFailButAdditionalFieldsAreAllowed() {
        assertTrue(runCatching { ApiContract.confirm(JSONObject("{}")) }.isFailure)
        assertTrue(runCatching { ApiContract.audio(JSONObject("{\"data\":\"AAAA\",\"mimeType\":\"audio/wav\"}")) }.isFailure)
        assertEquals("",ApiContract.confirm(JSONObject("{\"transcript\":\"\",\"match\":{\"label\":\"NONE\",\"action\":\"NOT_NOW\",\"mode\":\"none\"},\"future\":1}")).transcript)
        assertTrue(runCatching { WavAudio(java.util.Base64.getEncoder().encodeToString(ByteArray(2097153))).bytes() }.isFailure)
    }
}
