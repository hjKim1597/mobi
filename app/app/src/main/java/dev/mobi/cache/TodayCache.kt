package dev.mobi.cache

import android.content.Context
import android.util.AtomicFile
import dev.mobi.net.*
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Base64

/** A manifest commit is the only point at which a new two-file bundle becomes visible. */
class TodayCache(context: Context, origin: String, deviceId: String, private val now: () -> Instant = { Instant.now() }) {
    private val cachePath = "today/" + ApiContract.sha256("$origin\u0000$deviceId".toByteArray())
    private val legacyDirectory = File(context.filesDir, cachePath)
    val directory = File(context.noBackupFilesDir, cachePath).apply { mkdirs() }
    private val manifest = AtomicFile(File(directory, "bundle.json"))

    init {
        // Do not migrate cached calendar data into the new location; discard the plaintext legacy copy.
        legacyDirectory.deleteRecursively()
    }

    @Synchronized fun save(value: TodayResponse) {
        // Validate the whole response before changing the committed manifest.
        ApiContract.today(ApiContract.todayJson(value))
        val audio = listOf(value.knock.online, value.knock.offline)
        audio.forEach { asset ->
            val name = "${value.knock.version}-${asset.sha256}.wav"
            val file = File(directory, name)
            if (!file.isFile || ApiContract.sha256(file.readBytes()) != asset.sha256) {
                val target = AtomicFile(file); val out = target.startWrite()
                try { out.write(asset.audio.bytes()); target.finishWrite(out) }
                catch (e: Exception) { target.failWrite(out); throw e }
            }
        }
        val j = ApiContract.todayJson(value)
        for (key in listOf("online", "offline")) j.getJSONObject("knock").getJSONObject(key).getJSONObject("audio").put("data", "")
        val out = manifest.startWrite()
        try { out.write(j.toString().toByteArray()); manifest.finishWrite(out) }
        catch (e: Exception) { manifest.failWrite(out); throw e }
        val keep = audio.map { "${value.knock.version}-${it.sha256}.wav" }.toSet() + "bundle.json"
        directory.listFiles().orEmpty().filter { it.name !in keep }.forEach { it.delete() }
    }
    @Synchronized fun load(): TodayResponse? = runCatching {
        val j = JSONObject(String(manifest.readFully(), Charsets.UTF_8))
        val date = j.getString("date"); val zone = ZoneId.of(j.getString("timeZone"))
        require(LocalDate.ofInstant(now(), zone).toString() == date)
        val k = j.getJSONObject("knock"); require(k.getString("version") == "knock-v1")
        for (key in listOf("online", "offline")) {
            val asset = k.getJSONObject(key); val hash = asset.getString("sha256")
            require(hash.matches(Regex("[0-9a-f]{64}")))
            val bytes = File(directory, "knock-v1-$hash.wav").readBytes()
            require(ApiContract.sha256(bytes) == hash)
            asset.getJSONObject("audio").put("data", Base64.getEncoder().encodeToString(bytes))
        }
        ApiContract.today(j)
    }.getOrNull()
}
