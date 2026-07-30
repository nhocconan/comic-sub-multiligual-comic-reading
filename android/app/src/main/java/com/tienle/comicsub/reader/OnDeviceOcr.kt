package com.tienle.comicsub.reader

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

data class OnDeviceOcrPage(
    val width: Int,
    val height: Int,
    val regions: List<OverlayRegion>,
)

/**
 * Bundled ML Kit Text Recognition v2. Comic pixels never leave the device.
 *
 * The recognizer works on a bounded bitmap and maps every block back to the
 * source image coordinate space so WebView overlays remain stable after zoom,
 * scrolling, and viewport changes.
 */
class OnDeviceOcr : Closeable {
    private data class RetryCrop(
        val bitmap: Bitmap,
        val left: Int,
        val top: Int,
        val scale: Double,
    )

    private val recognizer: TextRecognizer = TextRecognition.getClient(
        ChineseTextRecognizerOptions.Builder().build(),
    )
    private val japaneseRecognizer: TextRecognizer = TextRecognition.getClient(
        JapaneseTextRecognizerOptions.Builder().build(),
    )

    fun recognizeBlocking(asset: BrokerClient.SourceAsset): OnDeviceOcrPage {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(asset.bytes, 0, asset.bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalArgumentException("Không giải mã được ảnh để OCR trên thiết bị.")
        }

        var sampleSize = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sampleSize > MAX_OCR_DIMENSION) {
            sampleSize *= 2
        }
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inScaled = false
            inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888
        }
        val bitmap = BitmapFactory.decodeByteArray(asset.bytes, 0, asset.bytes.size, options)
            ?: throw IllegalArgumentException("Định dạng ảnh chưa được Android hỗ trợ để OCR local.")
        val sourceWidth = bounds.outWidth
        val sourceHeight = bounds.outHeight
        val scaleX = sourceWidth.toDouble() / bitmap.width.coerceAtLeast(1)
        val scaleY = sourceHeight.toDouble() / bitmap.height.coerceAtLeast(1)
        val latch = CountDownLatch(1)
        var output: Result<OnDeviceOcrPage>? = null
        val enhanced = highContrastGrayscale(bitmap)

        val passes = listOf(
            recognizer.process(InputImage.fromBitmap(bitmap, 0)),
            recognizer.process(InputImage.fromBitmap(enhanced, 0)),
            japaneseRecognizer.process(InputImage.fromBitmap(bitmap, 0)),
        )
        Tasks.whenAllSuccess<Text>(passes)
            .addOnSuccessListener { recognizedPasses ->
                val preliminary = recognizedPasses.flatMap { recognized ->
                    mapRecognizedText(recognized, scaleX, scaleY)
                }
                val retryCrops = bestRecognitions(preliminary)
                    .filter(::isSuspiciousRecognition)
                    .take(MAX_RETRY_CROPS)
                    .mapNotNull { retryCrop(bitmap, it, scaleX, scaleY) }

                fun finish(extra: List<OverlayRegion> = emptyList()) {
                    val rawRegions = bestRecognitions(preliminary + extra)
                        .filter { isUsefulChineseText(it.source) }
                    val contextual = normalizeWithPageContext(rawRegions)
                    val regions = mergeDialogueBlocks(contextual, sourceWidth.toDouble())
                    output = Result.success(OnDeviceOcrPage(sourceWidth, sourceHeight, regions))
                    retryCrops.forEach { it.bitmap.recycle() }
                    bitmap.recycle()
                    enhanced.recycle()
                    latch.countDown()
                }

                if (retryCrops.isEmpty()) {
                    finish()
                } else {
                    val retryTasks = retryCrops.map { crop ->
                        japaneseRecognizer.process(InputImage.fromBitmap(crop.bitmap, 0))
                    }
                    Tasks.whenAllSuccess<Text>(retryTasks)
                        .addOnSuccessListener { retried ->
                            val extra = retried.flatMapIndexed { index, recognized ->
                                mapRetryText(recognized, retryCrops[index], scaleX, scaleY)
                            }
                            finish(extra)
                        }
                        .addOnFailureListener { finish() }
                }
            }
            .addOnFailureListener { error ->
                output = Result.failure(error)
                bitmap.recycle()
                enhanced.recycle()
                latch.countDown()
            }

        if (!latch.await(OCR_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            bitmap.recycle()
            enhanced.recycle()
            throw IllegalStateException("OCR trên thiết bị quá thời gian.")
        }
        return output?.getOrThrow()
            ?: throw IllegalStateException("OCR trên thiết bị không trả kết quả.")
    }

    override fun close() {
        recognizer.close()
        japaneseRecognizer.close()
    }

    private fun mapRecognizedText(
        recognized: Text,
        scaleX: Double,
        scaleY: Double,
    ): List<OverlayRegion> = recognized.textBlocks.mapNotNull { block ->
        val box = block.boundingBox ?: return@mapNotNull null
        val source = block.text.trim()
        if (source.isBlank() || box.width() <= 1 || box.height() <= 1) {
            return@mapNotNull null
        }
        OverlayRegion(
            id = "mlkit-${UUID.randomUUID()}",
            x = box.left * scaleX,
            y = box.top * scaleY,
            width = box.width() * scaleX,
            height = box.height() * scaleY,
            source = source,
            translation = "",
        )
    }

    private fun retryCrop(
        source: Bitmap,
        region: OverlayRegion,
        scaleX: Double,
        scaleY: Double,
    ): RetryCrop? {
        val rawLeft = region.x / scaleX
        val rawTop = region.y / scaleY
        val rawWidth = region.width / scaleX
        val rawHeight = region.height / scaleY
        val left = max(0.0, rawLeft - rawWidth * 0.8).toInt()
        val top = max(0.0, rawTop - rawHeight * 1.8).toInt()
        val right = min(source.width.toDouble(), rawLeft + rawWidth * 1.8).toInt()
        val bottom = min(source.height.toDouble(), rawTop + rawHeight * 2.8).toInt()
        if (right - left < 8 || bottom - top < 8) return null
        val cropped = Bitmap.createBitmap(source, left, top, right - left, bottom - top)
        val retryScale = min(
            3.0,
            RETRY_MAX_DIMENSION.toDouble() / max(cropped.width, cropped.height),
        ).coerceAtLeast(1.0)
        val scaled = Bitmap.createScaledBitmap(
            cropped,
            (cropped.width * retryScale).toInt().coerceAtLeast(1),
            (cropped.height * retryScale).toInt().coerceAtLeast(1),
            true,
        )
        if (scaled !== cropped) cropped.recycle()
        return RetryCrop(scaled, left, top, retryScale)
    }

    private fun mapRetryText(
        recognized: Text,
        crop: RetryCrop,
        scaleX: Double,
        scaleY: Double,
    ): List<OverlayRegion> = recognized.textBlocks.mapNotNull { block ->
        val box = block.boundingBox ?: return@mapNotNull null
        val source = block.text.trim()
        if (source.isBlank() || box.width() <= 1 || box.height() <= 1) {
            return@mapNotNull null
        }
        OverlayRegion(
            id = "mlkit-retry-${UUID.randomUUID()}",
            x = (crop.left + box.left / crop.scale) * scaleX,
            y = (crop.top + box.top / crop.scale) * scaleY,
            width = box.width() / crop.scale * scaleX,
            height = box.height() / crop.scale * scaleY,
            source = source,
            translation = "",
        )
    }

    private fun highContrastGrayscale(source: Bitmap): Bitmap {
        val output = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
        val contrast = 1.65f
        val offset = 128f * (1f - contrast)
        val luminance = floatArrayOf(
            .299f * contrast, .587f * contrast, .114f * contrast, 0f, offset,
            .299f * contrast, .587f * contrast, .114f * contrast, 0f, offset,
            .299f * contrast, .587f * contrast, .114f * contrast, 0f, offset,
            0f, 0f, 0f, 1f, 0f,
        )
        Canvas(output).drawBitmap(
            source,
            0f,
            0f,
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                colorFilter = ColorMatrixColorFilter(ColorMatrix(luminance))
            },
        )
        return output
    }

    private fun bestRecognitions(input: List<OverlayRegion>): List<OverlayRegion> {
        val selected = mutableListOf<OverlayRegion>()
        input.forEach { candidate ->
            val duplicateIndex = selected.indexOfFirst { existing ->
                overlapOverSmallerArea(existing, candidate) >= 0.5
            }
            if (duplicateIndex < 0) {
                selected += candidate
            } else if (recognitionScore(candidate.source) > recognitionScore(selected[duplicateIndex].source)) {
                selected[duplicateIndex] = candidate
            }
        }
        return selected
    }

    private fun recognitionScore(value: String): Int {
        val hanCount = value.count { HAN_CHARACTER.matches(it.toString()) }
        val latinCount = value.count { it in 'A'..'Z' || it in 'a'..'z' }
        return hanCount * 12 + value.length - latinCount * 3
    }

    private fun overlapOverSmallerArea(first: OverlayRegion, second: OverlayRegion): Double {
        val left = max(first.x, second.x)
        val top = max(first.y, second.y)
        val right = min(first.x + first.width, second.x + second.width)
        val bottom = min(first.y + first.height, second.y + second.height)
        val intersection = max(0.0, right - left) * max(0.0, bottom - top)
        val smaller = min(first.width * first.height, second.width * second.height)
        return intersection / smaller.coerceAtLeast(1.0)
    }

    private fun isUsefulChineseText(value: String): Boolean {
        val normalized = value.lowercase()
        if (
            normalized.contains("baozimh") ||
            normalized.contains("www.") ||
            normalized.contains("http") ||
            normalized.contains("包子漫画") ||
            normalized.contains("包子漫畫")
        ) {
            return false
        }
        val hanCount = value.count { HAN_CHARACTER.matches(it.toString()) }
        val latinCount = value.count { it in 'A'..'Z' || it in 'a'..'z' }
        return hanCount > 0 && hanCount * 2 >= latinCount
    }

    private fun isSuspiciousRecognition(region: OverlayRegion): Boolean {
        val hanCount = region.source.count { HAN_CHARACTER.matches(it.toString()) }
        val latinCount = region.source.count { it in 'A'..'Z' || it in 'a'..'z' }
        return hanCount == 0 || latinCount > hanCount * 2
    }

    private fun normalizeWithPageContext(input: List<OverlayRegion>): List<OverlayRegion> {
        val normalized = input.map { region ->
            region.copy(source = normalizeOcrConfusables(region.source))
        }
        val cjkTexts = normalized.map { cjkOnly(it.source) }
        return normalized.mapIndexed { index, region ->
            val current = cjkTexts[index]
            if (current.length !in 3..12) return@mapIndexed region
            var best: String? = null
            var bestDistance = Int.MAX_VALUE
            cjkTexts.forEachIndexed { otherIndex, other ->
                if (otherIndex == index || other.length < current.length) return@forEachIndexed
                for (start in 0..(other.length - current.length)) {
                    val candidate = other.substring(start, start + current.length)
                    val distance = editDistance(current, candidate)
                    if (distance < bestDistance) {
                        bestDistance = distance
                        best = candidate
                    }
                }
            }
            val allowedDistance = max(1, current.length / 5)
            if (best != null && bestDistance in 1..allowedDistance) {
                val punctuation = region.source.lastOrNull { it in "!?！？。.…" }?.toString().orEmpty()
                region.copy(source = best + punctuation)
            } else {
                region
            }
        }
    }

    private fun normalizeOcrConfusables(value: String): String =
        if (HAN_CHARACTER.containsMatchIn(value)) value.replace('カ', '力') else value

    private fun cjkOnly(value: String): String =
        value.filter { HAN_CHARACTER.matches(it.toString()) }

    private fun editDistance(first: String, second: String): Int {
        if (first.isEmpty()) return second.length
        if (second.isEmpty()) return first.length
        var previous = IntArray(second.length + 1) { it }
        first.forEachIndexed { firstIndex, firstCharacter ->
            val current = IntArray(second.length + 1)
            current[0] = firstIndex + 1
            second.forEachIndexed { secondIndex, secondCharacter ->
                current[secondIndex + 1] = min(
                    min(current[secondIndex] + 1, previous[secondIndex + 1] + 1),
                    previous[secondIndex] + if (firstCharacter == secondCharacter) 0 else 1,
                )
            }
            previous = current
        }
        return previous[second.length]
    }

    private fun mergeDialogueBlocks(
        input: List<OverlayRegion>,
        pageWidth: Double,
    ): List<OverlayRegion> {
        val merged = mutableListOf<OverlayRegion>()
        input.sortedWith(compareBy<OverlayRegion> { it.y }.thenBy { it.x }).forEach { region ->
            val targetIndex = merged.indexOfLast { existing ->
                shouldMerge(existing, region, pageWidth)
            }
            if (targetIndex < 0) {
                merged += region
            } else {
                merged[targetIndex] = union(merged[targetIndex], region)
            }
        }
        return merged
    }

    private fun shouldMerge(
        first: OverlayRegion,
        second: OverlayRegion,
        pageWidth: Double,
    ): Boolean {
        val firstRight = first.x + first.width
        val secondRight = second.x + second.width
        val overlapX = max(0.0, min(firstRight, secondRight) - max(first.x, second.x))
        val overlapRatio = overlapX / min(first.width, second.width).coerceAtLeast(1.0)
        val firstBottom = first.y + first.height
        val secondBottom = second.y + second.height
        val verticalGap = max(0.0, max(first.y, second.y) - min(firstBottom, secondBottom))
        val centerDistance = abs(
            (first.x + first.width / 2) - (second.x + second.width / 2),
        )
        val aligned = overlapRatio >= 0.35 ||
            centerDistance <= max(first.width, second.width) * 0.28
        val nearby = verticalGap <= max(first.height, second.height) * 2.8
        val unionWidth = max(firstRight, secondRight) - min(first.x, second.x)
        return aligned && nearby && unionWidth <= pageWidth * 0.58
    }

    private fun union(first: OverlayRegion, second: OverlayRegion): OverlayRegion {
        val left = min(first.x, second.x)
        val top = min(first.y, second.y)
        val right = max(first.x + first.width, second.x + second.width)
        val bottom = max(first.y + first.height, second.y + second.height)
        val orderedLines = listOf(first, second)
            .sortedBy { it.y }
            .flatMap { it.source.lines() }
            .map(String::trim)
            .filter(String::isNotBlank)
            .fold(mutableListOf<String>()) { lines, candidate ->
                val canonical = canonicalLine(candidate)
                val duplicate = lines.any { existing ->
                    val existingCanonical = canonicalLine(existing)
                    min(canonical.length, existingCanonical.length) >= 4 &&
                        editDistance(canonical, existingCanonical) <= 1
                }
                if (!duplicate) lines += candidate
                lines
            }
        return OverlayRegion(
            id = first.id,
            x = left,
            y = top,
            width = right - left,
            height = bottom - top,
            source = orderedLines.joinToString("\n"),
            translation = "",
        )
    }

    private fun canonicalLine(value: String): String =
        normalizeOcrConfusables(value)
            .replace('時', '时')
            .replace('錯', '错')
            .replace(Regex("\\s+"), "")

    private companion object {
        val HAN_CHARACTER = Regex("[\\u3400-\\u9FFF\\uF900-\\uFAFF]")
        const val MAX_OCR_DIMENSION = 3072
        const val MAX_RETRY_CROPS = 12
        const val RETRY_MAX_DIMENSION = 1600
        const val OCR_TIMEOUT_SECONDS = 45L
    }
}
