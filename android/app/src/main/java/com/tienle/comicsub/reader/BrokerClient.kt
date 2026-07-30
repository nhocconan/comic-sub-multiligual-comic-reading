package com.tienle.comicsub.reader

import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

class BrokerClient {
    data class SourceAsset(val bytes: ByteArray, val mime: String)
    data class CreatedJob(val batchId: String, val jobId: String)
    data class SeriesBootstrap(val seriesId: String, val glossarySnapshot: JSONObject)

    fun downloadCandidate(candidate: ComicCandidate, documentUrl: String): SourceAsset {
        val expected = URI(candidate.url)
        val connection = (URL(candidate.url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5")
            setRequestProperty("Referer", documentUrl)
            CookieManager.getInstance().getCookie(candidate.url)?.takeIf { it.isNotBlank() }?.let {
                setRequestProperty("Cookie", it)
            }
        }
        try {
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("Không tải được ảnh (HTTP ${connection.responseCode}).")
            }
            val finalUri = connection.url.toURI()
            if (finalUri.scheme != expected.scheme || finalUri.host != expected.host) {
                throw SecurityException("Nguồn ảnh chuyển sang host chưa đăng ký.")
            }
            val declaredLength = connection.contentLengthLong
            if (declaredLength > ReaderPolicy.MAX_SOURCE_BYTES) {
                throw IllegalArgumentException("Ảnh vượt giới hạn 32 MB.")
            }
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(32 * 1024)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > ReaderPolicy.MAX_SOURCE_BYTES) {
                        throw IllegalArgumentException("Ảnh vượt giới hạn 32 MB.")
                    }
                    output.write(buffer, 0, read)
                }
            }
            val bytes = output.toByteArray()
            val mime = connection.contentType?.substringBefore(';')?.lowercase()
                ?.takeIf { it in setOf("image/jpeg", "image/png", "image/webp", "image/avif") }
                ?: sniffMime(bytes)
            return SourceAsset(bytes, mime)
        } finally {
            connection.disconnect()
        }
    }

    fun createJob(
        candidate: ComicCandidate,
        settings: ReaderSettings,
        documentUrl: String,
        documentTitle: String,
        glossary: JSONObject,
        clientOcr: OnDeviceOcrPage,
    ): CreatedJob {
        val batchKey = UUID.randomUUID().toString()
        val snapshotId = UUID.randomUUID().toString()
        val documentOrigin = URI(documentUrl).let { "${it.scheme}://${it.authority}/" }
        val sourceOrigin = URI(candidate.url).let { "${it.scheme}://${it.authority}/" }
        val snapshot = JSONObject()
            .put("snapshotId", snapshotId)
            .put("navigationId", UUID.randomUUID().toString())
            .put("topFrameOrigin", documentOrigin)
            .put("createdAt", Instant.now().toString())
            .put("candidates", JSONArray().put(JSONObject()
                .put("candidateId", candidate.id)
                .put("frameId", "top")
                .put("domOrdinal", candidate.index)
                .put("sourceUrl", candidate.url)
                .put("sourceOrigin", sourceOrigin)
                .put("renderedRect", JSONObject()
                    .put("x", 0)
                    .put("y", candidate.top)
                    .put("width", candidate.width.coerceAtLeast(1))
                    .put("height", candidate.height.coerceAtLeast(1)))
                .put("intrinsicWidth", clientOcr.width.coerceAtLeast(1))
                .put("intrinsicHeight", clientOcr.height.coerceAtLeast(1))
                .put("acquisitionCapabilities", JSONArray().put("source-blob"))))
        jsonRequest(
            endpoint = settings.endpoint,
            path = "/v1/snapshots",
            method = "POST",
            authKey = settings.authKey,
            body = snapshot.toString().toByteArray(),
            contentType = "application/json",
        )
        val route = when (settings.route) {
            "device" -> "on-device"
            "paired" -> "paired"
            "managed" -> "managed"
            else -> "local"
        }
        val provider = if (settings.route == "device") "mlkit" else "gemini"
        val model = if (settings.route == "device") "mlkit-translation" else settings.model
        val body = JSONObject()
            .put("snapshotId", snapshotId)
            .put("candidateIds", JSONArray().put(candidate.id))
            .put("requestedExecution", JSONObject()
                .put("locus", route)
                .put("profile", if (settings.route == "device") "fast" else "balanced")
                .put("provider", provider)
                .put("model", model)
                .put("allowedFallbacks", JSONArray()))
            .put("pipeline", JSONObject()
                .put("translationMode", "client-ocr")
                .put("ocrVersion", "mlkit-text-recognition-v2-chinese")
                .put("layoutVersion", "client-geometry")
                .put("renderVersion", "source-overlay-v1")
                .put("promptVersion", "series-intelligence-1"))
            .put("language", JSONObject().put("source", "zh-Hans").put("target", settings.targetLanguage))
            .put("glossarySnapshot", glossary)
            .put("privacyPolicyVersion", "2026-07-30")
            .put("budget", JSONObject().put("currency", "USD").put("maxMicros", 500_000))
            .put("clientOcr", JSONObject().put(candidate.id, JSONObject()
                .put("page", JSONObject()
                    .put("width", clientOcr.width)
                    .put("height", clientOcr.height))
                .put("regions", JSONArray().apply {
                    clientOcr.regions.forEach { region ->
                        put(JSONObject()
                            .put("id", region.id)
                            .put("x", region.x)
                            .put("y", region.y)
                            .put("width", region.width)
                            .put("height", region.height)
                            .put("rotation", 0)
                            .put("source", region.source))
                    }
                })))
        val response = jsonRequest(
            endpoint = settings.endpoint,
            path = "/v1/job-batches",
            method = "POST",
            authKey = settings.authKey,
            headers = mapOf("Idempotency-Key" to batchKey),
            body = body.toString().toByteArray(),
            contentType = "application/json",
        )
        val batchId = response.optString("batchId")
        val jobs = response.optJSONArray("jobs")
        val jobId = jobs?.optJSONObject(0)?.optString("jobId").orEmpty()
            .ifBlank { response.optJSONArray("jobIds")?.optString(0).orEmpty() }
        if (batchId.isBlank() || jobId.isBlank()) {
            throw IllegalStateException("Broker không trả về batch/job ID.")
        }
        return CreatedJob(batchId, jobId)
    }

    fun bootstrapSeries(
        settings: ReaderSettings,
        documentTitle: String,
        documentUrl: String,
        locallyObservedAliases: List<String>,
    ): SeriesBootstrap {
        val normalizedTitle = documentTitle.trim().replace(Regex("\\s+"), " ").take(256)
            .ifBlank { URI(documentUrl).host ?: "Unknown series" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${normalizedTitle.lowercase()}|${settings.targetLanguage}".toByteArray())
            .joinToString("") { "%02x".format(it) }
        val seriesId = "series-${digest.take(32)}"
        val body = JSONObject()
            .put("seriesId", seriesId)
            .put("title", normalizedTitle)
            .put("seriesStatus", if (normalizedTitle.length >= 3) "confirmed" else "ambiguous")
            .put("chapterBoundary", URI(documentUrl).path.takeLast(256))
            .put("targetLanguage", settings.targetLanguage)
            .put("privateMode", settings.privateSession)
            .put("localContinuity", JSONArray())
            .put("userCorrections", JSONArray())
            .put("locallyObservedAliases", JSONArray().apply {
                locallyObservedAliases.map(String::trim).filter(String::isNotBlank).take(200).forEach(::put)
            })
        if (settings.researchConsent == true && !settings.privateSession) {
            body.put("researchConsent", JSONObject()
                .put("seriesId", seriesId)
                .put("policyVersion", "series-research-v1")
                .put("state", "granted")
                .put("allowedSourceClasses", JSONArray()
                    .put("wikidata")
                    .put("mediawiki")
                    .put("anilist"))
                .put("grantedAt", Instant.now().toString()))
        }
        val response = jsonRequest(
            settings.endpoint,
            "/v1/series/bootstrap",
            "POST",
            settings.authKey,
            body = body.toString().toByteArray(),
            contentType = "application/json",
        )
        val snapshot = response.optJSONObject("glossarySnapshot")
            ?: JSONObject().put("id", seriesId).put("version", 0).put("hash", "0".repeat(64))
        return SeriesBootstrap(seriesId, snapshot)
    }

    fun getSeriesGlossary(settings: ReaderSettings, seriesId: String): JSONObject {
        val response = jsonRequest(
            settings.endpoint,
            "/v1/series/${pathSegment(seriesId)}/glossary",
            "GET",
            settings.authKey,
        )
        return response.optJSONObject("glossarySnapshot")
            ?: JSONObject().put("id", seriesId).put("version", 0).put("hash", "0".repeat(64))
    }

    fun awaitReceipt(settings: ReaderSettings, created: CreatedJob): JobReceipt {
        repeat(180) {
            val response = jsonRequest(
                endpoint = settings.endpoint,
                path = "/v1/jobs/${pathSegment(created.jobId)}",
                method = "GET",
                authKey = settings.authKey,
            )
            val status = response.optString("state").uppercase()
            if (status == "SETTLED") {
                val result = jsonRequest(
                    settings.endpoint,
                    "/v1/jobs/${pathSegment(created.jobId)}/result",
                    "GET",
                    settings.authKey,
                )
                return parseReceipt(result, created, settings)
            }
            if (status in setOf("FAILED", "REJECTED", "CANCELLED", "EXPIRED")) {
                val message = response.optJSONObject("error")?.optString("message")
                    ?: response.optString("error", "Job kết thúc ở trạng thái $status.")
                throw IllegalStateException(message)
            }
            Thread.sleep(1_000)
        }
        throw IllegalStateException("Job dịch quá thời gian 3 phút.")
    }

    fun cancel(settings: ReaderSettings, jobId: String) {
        runCatching {
            jsonRequest(
                settings.endpoint,
                "/v1/jobs/${pathSegment(jobId)}/cancel",
                "POST",
                settings.authKey,
                body = "{}".toByteArray(),
                contentType = "application/json",
            )
        }
    }

    private fun parseReceipt(
        response: JSONObject,
        created: CreatedJob,
        settings: ReaderSettings,
    ): JobReceipt {
        val receipt = response.optJSONObject("modelReceipt") ?: JSONObject()
        val resolvedModel = receipt.optString(
            "resolvedModel",
            if (settings.route == "device") "mlkit-translation" else settings.model,
        )
        if (settings.route != "device" && (
                resolvedModel.isNotBlank() && resolvedModel != settings.model ||
                    !receipt.optBoolean("modelMatched", true)
                )) {
            throw IllegalStateException("Broker dùng $resolvedModel thay vì ${settings.model}; hàng đợi đã dừng.")
        }
        val regions = parseRegions(response.optJSONArray("overlayRegions"))
        return JobReceipt(
            jobId = created.jobId,
            batchId = created.batchId,
            status = "SETTLED",
            requestedModel = settings.model,
            resolvedModel = resolvedModel,
            locus = settings.route,
            diagnosticId = receipt.optString("executionFingerprint", created.jobId),
            regions = if (settings.route == "device") emptyList() else regions,
            sourceRegions = if (settings.route == "device") regions else emptyList(),
        )
    }

    private fun parseRegions(array: JSONArray?): List<OverlayRegion> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            OverlayRegion(
                id = item.optString("id", index.toString()),
                x = item.optDouble("x"),
                y = item.optDouble("y"),
                width = item.optDouble("width"),
                height = item.optDouble("height"),
                source = item.optString("source", item.optString("text")),
                translation = item.optString("translation"),
            )
        }
    }

    private fun jsonRequest(
        endpoint: String,
        path: String,
        method: String,
        authKey: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        contentType: String? = null,
    ): JSONObject {
        if (!ReaderPolicy.validEndpoint(endpoint)) throw SecurityException("Endpoint không hợp lệ.")
        val connection = (URL(endpoint.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 30_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            if (authKey.isNotBlank()) setRequestProperty("Authorization", "Bearer ${authKey.trim()}")
            headers.forEach { (name, value) -> setRequestProperty(name, value) }
            if (body != null) {
                doOutput = true
                if (contentType != null) setRequestProperty("Content-Type", contentType)
                outputStream.use { it.write(body) }
            }
        }
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val message = runCatching {
                    val error = JSONObject(text).optJSONObject("error")
                    error?.optString("message")
                }.getOrNull()
                throw IllegalStateException(message?.takeIf { it.isNotBlank() } ?: "Broker HTTP $status.")
            }
            return if (text.isBlank()) JSONObject().put("ok", true) else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun sniffMime(bytes: ByteArray): String {
        if (bytes.size >= 8 && bytes.sliceArray(0..7).contentEquals(
                byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
            )) return "image/png"
        if (bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte()) {
            return "image/jpeg"
        }
        if (bytes.size >= 12 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WEBP") {
            return "image/webp"
        }
        throw IllegalArgumentException("Định dạng ảnh không được hỗ trợ.")
    }

    private fun pathSegment(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")
}
