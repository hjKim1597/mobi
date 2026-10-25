package dev.mobi.ui

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

object QrCode {
    fun matrix(url: String, size: Int): BitMatrix = QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, size, size,
        mapOf(EncodeHintType.CHARACTER_SET to "UTF-8", EncodeHintType.MARGIN to 4, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L))
    fun bitmap(url: String, size: Int): Bitmap {
        val matrix = matrix(url, size)
        return Bitmap.createBitmap(IntArray(size * size) { i -> if (matrix[i % size, i / size]) 0xff000000.toInt() else 0xffffffff.toInt() }, size, size, Bitmap.Config.ARGB_8888)
    }
}
