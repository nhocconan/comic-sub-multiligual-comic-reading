package com.tienle.comicsub.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReaderPolicyTest {
    @Test
    fun defaultsToGemini36Flash() {
        assertEquals("gemini-3.6-flash", ReaderPolicy.DEFAULT_MODEL)
        assertEquals("https://comic-be.dep.app", ReaderPolicy.DEFAULT_ENDPOINT)
    }

    @Test
    fun appLanguageDefaultsToEnglishIndependentlyOfTranslationLanguage() {
        val settings = ReaderSettings()

        assertEquals("en", settings.uiLanguage)
        assertEquals("vi", settings.targetLanguage)
    }

    @Test
    fun normalizesChapterUrls() {
        assertEquals("https://example.com/chapter/1", ReaderPolicy.normalizedWebUrl("example.com/chapter/1"))
        assertNull(ReaderPolicy.normalizedWebUrl("javascript:alert(1)"))
    }

    @Test
    fun endpointRequiresHttpsOrLocalNetwork() {
        assertTrue(ReaderPolicy.validEndpoint("https://comic.example/api"))
        assertTrue(ReaderPolicy.validEndpoint("http://127.0.0.1:4317"))
        assertTrue(ReaderPolicy.validEndpoint("http://192.168.1.4:4317"))
        assertFalse(ReaderPolicy.validEndpoint("http://public.example/api"))
        assertFalse(ReaderPolicy.validEndpoint("file:///tmp/api"))
    }

    @Test
    fun compactToolbarKeepsAUsableAddressFieldOnNarrowPhones() {
        assertTrue(ReaderPolicy.toolbarAddressWidthDp(360) >= 110)
        assertEquals(165, ReaderPolicy.toolbarAddressWidthDp(411))
    }

    @Test
    fun translateCurrentChoosesTheImageWithTheLargestVisibleArea() {
        val dominant = ComicCandidate(
            "first", "https://example.com/1.jpg", 0, 1000, 1600,
            95.0, 678.0, true, 583.0,
        )
        val next = ComicCandidate(
            "second", "https://example.com/2.jpg", 1, 1000, 1600,
            678.0, 1_365.0, true, 106.0,
        )

        assertEquals(
            dominant,
            ReaderPolicy.currentCandidate(listOf(dominant, next)),
        )
    }
}
