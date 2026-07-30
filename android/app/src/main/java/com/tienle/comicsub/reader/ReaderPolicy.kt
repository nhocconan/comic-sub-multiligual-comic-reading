package com.tienle.comicsub.reader

import java.net.URI

object ReaderPolicy {
    const val DEFAULT_MODEL = "gemini-3.6-flash"
    const val DEFAULT_ENDPOINT = "https://comic-be.dep.app"
    const val LEGACY_EMULATOR_ENDPOINT = "http://10.0.2.2:4100"
    const val MAX_BATCH_IMAGES = 200
    const val MAX_SOURCE_BYTES = 32 * 1024 * 1024
    const val TOOLBAR_ACTION_WIDTH_DP = 44
    const val TOOLBAR_ACTION_COUNT = 5
    const val TOOLBAR_HORIZONTAL_CHROME_DP = 26

    fun toolbarAddressWidthDp(screenWidthDp: Int): Int =
        screenWidthDp - (TOOLBAR_ACTION_WIDTH_DP * TOOLBAR_ACTION_COUNT) -
            TOOLBAR_HORIZONTAL_CHROME_DP

    fun normalizedWebUrl(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
        return runCatching {
            val uri = URI(withScheme)
            if ((uri.scheme == "https" || uri.scheme == "http") && !uri.host.isNullOrBlank()) {
                uri.toASCIIString()
            } else {
                null
            }
        }.getOrNull()
    }

    fun validEndpoint(value: String): Boolean {
        val uri = runCatching { URI(value.trim().trimEnd('/')) }.getOrNull() ?: return false
        if (uri.host.isNullOrBlank()) return false
        if (uri.scheme == "https") return true
        if (uri.scheme != "http") return false
        val host = uri.host.lowercase()
        return host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2" ||
            host.startsWith("192.168.") || host.startsWith("10.")
    }

    fun safeDiagnosticId(value: String): String =
        value.replace(Regex("[^A-Za-z0-9_-]"), "").take(64)
}
