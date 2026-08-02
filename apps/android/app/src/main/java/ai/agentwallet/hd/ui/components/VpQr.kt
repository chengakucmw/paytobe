package ai.agentwallet.hd.ui.components

import ai.agentwallet.hd.VpLog
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/**
 * 用项目已有的 ZXing 依赖把字符串（钱包地址）渲染成二维码。
 * 纯本地生成，无网络。生成失败时显示空占位。
 */
@Composable
fun VpQrCode(content: String, modifier: Modifier = Modifier, sizePx: Int = 600) {
    val image = remember(content, sizePx) { generateQr(content, sizePx)?.asImageBitmap() }
    if (image != null) {
        Image(bitmap = image, contentDescription = "Receive address QR code", modifier = modifier)
    } else {
        Box(modifier)
    }
}

private fun generateQr(content: String, size: Int): Bitmap? {
    if (content.isBlank()) return null
    return try {
        val hints = hashMapOf<EncodeHintType, Any>(EncodeHintType.MARGIN to 1)
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size, hints)
        val width = matrix.width
        val height = matrix.height
        val pixels = IntArray(width * height)
        for (y in 0 until height) {
            val offset = y * width
            for (x in 0 until width) {
                pixels[offset + x] = if (matrix.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
            }
        }
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
            it.setPixels(pixels, 0, width, 0, 0, width, height)
        }
    } catch (e: Exception) {
        VpLog.w("VpQr", "QR encode failed; showing empty placeholder", e)
        null
    }
}
