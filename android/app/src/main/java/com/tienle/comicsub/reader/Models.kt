package com.tienle.comicsub.reader

import org.json.JSONArray
import org.json.JSONObject

data class ReaderSettings(
    val endpoint: String = ReaderPolicy.DEFAULT_ENDPOINT,
    val authKey: String = "",
    val targetLanguage: String = "vi",
    val route: String = "ask",
    val model: String = ReaderPolicy.DEFAULT_MODEL,
    val privateSession: Boolean = false,
    val researchConsent: Boolean? = null,
)

data class ComicCandidate(
    val id: String,
    val url: String,
    val index: Int,
    val width: Int,
    val height: Int,
    val top: Double,
    val bottom: Double,
    val visible: Boolean,
) {
    companion object {
        fun listFromJson(value: String): List<ComicCandidate> {
            val array = JSONArray(value)
            return (0 until array.length()).mapNotNull { position ->
                val item = array.optJSONObject(position) ?: return@mapNotNull null
                val id = item.optString("id")
                val url = item.optString("url")
                if (id.isBlank() || url.isBlank()) return@mapNotNull null
                ComicCandidate(
                    id = id,
                    url = url,
                    index = item.optInt("index", position),
                    width = item.optInt("width"),
                    height = item.optInt("height"),
                    top = item.optDouble("top"),
                    bottom = item.optDouble("bottom"),
                    visible = item.optBoolean("visible"),
                )
            }
        }
    }
}

data class OverlayRegion(
    val id: String,
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val source: String,
    val translation: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("x", x)
        .put("y", y)
        .put("width", width)
        .put("height", height)
        .put("source", source)
        .put("translation", translation)
}

data class JobReceipt(
    val jobId: String,
    val batchId: String,
    val status: String,
    val requestedModel: String,
    val resolvedModel: String,
    val locus: String,
    val diagnosticId: String,
    val regions: List<OverlayRegion>,
    val sourceRegions: List<OverlayRegion> = emptyList(),
)

data class ReadingProgress(
    val url: String,
    val title: String,
    val candidateId: String,
    val ordinal: Int,
    val intraImageRatio: Double,
    val scrollRatio: Double,
    val updatedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("url", url)
        .put("title", title)
        .put("candidateId", candidateId)
        .put("ordinal", ordinal)
        .put("intraImageRatio", intraImageRatio)
        .put("scrollRatio", scrollRatio)
        .put("updatedAt", updatedAt)

    companion object {
        fun fromJson(value: JSONObject): ReadingProgress? {
            val url = value.optString("url")
            if (url.isBlank()) return null
            return ReadingProgress(
                url = url,
                title = value.optString("title"),
                candidateId = value.optString("candidateId"),
                ordinal = value.optInt("ordinal"),
                intraImageRatio = value.optDouble("intraImageRatio"),
                scrollRatio = value.optDouble("scrollRatio"),
                updatedAt = value.optLong("updatedAt"),
            )
        }
    }
}
