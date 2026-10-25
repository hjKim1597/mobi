package dev.mobi.net

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceAuth(context: Context, private val origin: String, namespace: String = "device-auth") {
    private val id = ApiContract.sha256(origin.toByteArray()).take(32)
    val file = File(context.filesDir, "$namespace/$id.bin").also { it.parentFile!!.mkdirs() }
    private val alias = "mobi.$namespace.$id"
    private val store get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    @Synchronized private fun key(): SecretKey {
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun load(): DeviceCredentials? = runCatching {
        val bytes = AtomicFile(file).readFully(); require(bytes.size > 30 && bytes[0].toInt() == 1 && bytes[1].toInt() == 12)
        val k = store.getKey(alias, null) as? SecretKey ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, bytes.copyOfRange(2, 14))); updateAAD(origin.toByteArray())
        }
        val plain = cipher.doFinal(bytes, 14, bytes.size - 14)
        try { val j = JSONObject(String(plain, Charsets.UTF_8)); DeviceCredentials(j.getString("deviceId"), j.getString("deviceToken")) }
        finally { plain.fill(0) }
    }.getOrNull()
    @Synchronized fun save(value: DeviceCredentials) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(origin.toByteArray()) }
        val plain = JSONObject().put("deviceId", value.deviceId).put("deviceToken", value.deviceToken).toString().toByteArray()
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        val atomic = AtomicFile(file); val out = atomic.startWrite()
        try { out.write(byteArrayOf(1, 12)); out.write(cipher.iv); out.write(encrypted); atomic.finishWrite(out) }
        catch (e: Exception) { atomic.failWrite(out); throw e }
    }
    @Synchronized fun clear() { AtomicFile(file).delete(); runCatching { store.deleteEntry(alias) } }
}
