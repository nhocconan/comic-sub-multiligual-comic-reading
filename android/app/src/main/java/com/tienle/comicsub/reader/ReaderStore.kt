package com.tienle.comicsub.reader

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class ReaderStore(context: Context) {
    private val preferences = context.getSharedPreferences("comic_sub_reader", Context.MODE_PRIVATE)

    fun settings(): ReaderSettings = ReaderSettings(
        endpoint = preferences.getString("endpoint", ReaderPolicy.DEFAULT_ENDPOINT)
            ?.takeUnless { it == ReaderPolicy.LEGACY_EMULATOR_ENDPOINT }
            ?: ReaderPolicy.DEFAULT_ENDPOINT,
        authKey = preferences.getString("authKey", "") ?: "",
        uiLanguage = preferences.getString("uiLanguage", "en")
            ?.takeIf { it in setOf("en", "vi") }
            ?: "en",
        targetLanguage = preferences.getString("targetLanguage", "vi") ?: "vi",
        route = preferences.getString("route", "ask") ?: "ask",
        model = migrateModel(preferences.getString("model", ReaderPolicy.DEFAULT_MODEL)),
        privateSession = preferences.getBoolean("privateSession", false),
        researchConsent = if (preferences.contains("researchConsent")) {
            preferences.getBoolean("researchConsent", false)
        } else {
            null
        },
    )

    fun save(settings: ReaderSettings) {
        preferences.edit()
            .putString("endpoint", settings.endpoint.trimEnd('/'))
            .putString("authKey", settings.authKey)
            .putString("uiLanguage", settings.uiLanguage)
            .putString("targetLanguage", settings.targetLanguage)
            .putString("route", settings.route)
            .putString("model", settings.model)
            .putBoolean("privateSession", settings.privateSession)
            .apply {
                if (settings.researchConsent == null) remove("researchConsent")
                else putBoolean("researchConsent", settings.researchConsent)
            }
            .apply()
    }

    private fun migrateModel(value: String?): String {
        val model = value.orEmpty().trim()
        return when {
            model.isBlank() -> ReaderPolicy.DEFAULT_MODEL
            model in setOf("gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview") ->
                ReaderPolicy.DEFAULT_MODEL
            else -> model
        }
    }

    fun history(): List<ReadingProgress> {
        val raw = preferences.getString("history", "[]") ?: "[]"
        val values = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        return (0 until values.length()).mapNotNull { index ->
            ReadingProgress.fromJson(values.optJSONObject(index) ?: JSONObject())
        }.sortedByDescending { it.updatedAt }
    }

    fun upsert(progress: ReadingProgress) {
        if (settings().privateSession) return
        val next = history().filterNot { it.url == progress.url }.toMutableList()
        next.add(0, progress)
        val array = JSONArray()
        next.take(100).forEach { array.put(it.toJson()) }
        preferences.edit().putString("history", array.toString()).apply()
    }

    fun clearHistory() {
        preferences.edit().remove("history").apply()
    }
}
