package dev.mobi.net
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.KeyStore
import java.util.UUID
class DeviceAuthTest {
 @Test fun ciphertextSurvivesRecreationUsesFreshIvAndSeparatesOrigins() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val a=DeviceAuth(ctx,"https://a.test","auth-test")
  val b=DeviceAuth(ctx,"https://b.test","auth-test")
  try {
   val value=DeviceCredentials("test-id","TOKEN_FIXTURE_PRIVATE")
   a.save(value);val first=a.file.readBytes();assertFalse(String(first).contains(value.deviceToken))
   assertEquals(value,DeviceAuth(ctx,"https://a.test","auth-test").load());assertNull(b.load())
   a.save(value);assertFalse(first.contentEquals(a.file.readBytes()))
   a.file.writeBytes(byteArrayOf(1,2,3));assertNull(a.load())
   a.save(value);a.clear();assertNull(a.load())
  } finally {a.clear();b.clear()}
 }

 @Test fun deletedKeystoreKeyIsUnregisteredAndCanBeReplaced() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val origin="https://deleted-key.test"
  val namespace="device-auth-test-${UUID.randomUUID()}"
  val auth=DeviceAuth(ctx,origin,namespace)
  val original=DeviceCredentials("deleted-key-id","DELETED_KEY_TOKEN_FIXTURE")
  val replacement=DeviceCredentials("replacement-id","REPLACEMENT_TOKEN_FIXTURE")
  val alias="mobi.$namespace.${ApiContract.sha256(origin.toByteArray()).take(32)}"
  try {
   auth.save(original)
   val ciphertext=auth.file.readBytes()
   assertEquals(original,auth.load())
   assertFalse(String(ciphertext).contains(original.deviceToken))

   // Delete only this test instance's key; never touch the app's credential alias.
   KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }

   assertNull("Credentials without their decrypting key must be treated as unregistered",auth.load())
   assertArrayEquals("A missing key must not rewrite ciphertext into plaintext",ciphertext,auth.file.readBytes())
   assertFalse(String(auth.file.readBytes()).contains(original.deviceToken))

   auth.save(replacement)
   assertEquals(replacement,DeviceAuth(ctx,origin,namespace).load())
   assertFalse(String(auth.file.readBytes()).contains(replacement.deviceToken))
  } finally { auth.clear() }
 }

 @Test fun ciphertextFromAnUnusableKeyIsUnregisteredAndCanBeReplaced() {
  val ctx=InstrumentationRegistry.getInstrumentation().targetContext
  val origin="https://unusable-key.test"
  val namespace="device-auth-test-${UUID.randomUUID()}"
  val auth=DeviceAuth(ctx,origin,namespace)
  val original=DeviceCredentials("old-key-id","OLD_KEY_TOKEN_FIXTURE")
  val replacement=DeviceCredentials("new-key-id","NEW_KEY_TOKEN_FIXTURE")
  val alias="mobi.$namespace.${ApiContract.sha256(origin.toByteArray()).take(32)}"
  try {
   auth.save(original);val ciphertext=auth.file.readBytes()
   KeyStore.getInstance("AndroidKeyStore").apply { load(null);deleteEntry(alias) }
   auth.save(replacement);assertEquals(replacement,auth.load())
   // Keep a well-formed envelope but make its original decrypting key unavailable.
   // This reaches real GCM authentication failure, without changing device credentials.
   auth.file.writeBytes(ciphertext)
   assertNull(auth.load())
   assertArrayEquals(ciphertext,auth.file.readBytes())
   assertFalse(String(auth.file.readBytes()).contains(original.deviceToken))
   assertFalse(String(auth.file.readBytes()).contains(replacement.deviceToken))
   auth.save(replacement)
   assertEquals(replacement,DeviceAuth(ctx,origin,namespace).load())
  } finally { auth.clear() }
 }
}
