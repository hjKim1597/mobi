package dev.mobi.ui
import com.google.zxing.*
import com.google.zxing.common.*
import org.junit.Assert.*
import org.junit.Test
class QrCodeTest {
 @Test fun encodesFullUrlWithQuietZoneAndUnicodeWithoutCustomCapacityLimit() {
  for (url in listOf("https://mobi-dev.mobi-car.workers.dev/pair/"+"A".repeat(43), "https://example.test/"+"a".repeat(272), "https://example.test/한글")) {
   val matrix=QrCode.matrix(url,512)
   assertFalse(matrix[0,0]); assertEquals(512,matrix.width)
   val pixels=IntArray(512*512){i->if(matrix[i%512,i/512]) 0xff000000.toInt() else 0xffffffff.toInt()}
   val source=RGBLuminanceSource(512,512,pixels)
   assertEquals(url,MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source))).text)
  }
 }
}
