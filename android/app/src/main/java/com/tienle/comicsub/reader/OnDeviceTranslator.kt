package com.tienle.comicsub.reader

import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.TranslatorOptions

class OnDeviceTranslator(private val lifecycleOwner: LifecycleOwner) {
    fun translate(
        regions: List<OverlayRegion>,
        targetLanguage: String,
        onStatus: (String) -> Unit,
        completion: (Result<List<OverlayRegion>>) -> Unit,
    ) {
        val target = mlKitLanguage(targetLanguage)
        if (target == null) {
            completion(Result.failure(IllegalArgumentException("Ngôn ngữ này chưa được ML Kit hỗ trợ.")))
            return
        }
        val options = TranslatorOptions.Builder()
            .setSourceLanguage(TranslateLanguage.CHINESE)
            .setTargetLanguage(target)
            .build()
        val translator = Translation.getClient(options)
        lifecycleOwner.lifecycle.addObserver(translator)
        onStatus("Đang chuẩn bị gói ngôn ngữ trên thiết bị…")
        translator.downloadModelIfNeeded(DownloadConditions.Builder().requireWifi().build())
            .addOnFailureListener { error -> completion(Result.failure(error)) }
            .addOnSuccessListener {
                val translated = ArrayList<OverlayRegion>(regions.size)
                fun translateAt(index: Int) {
                    if (index >= regions.size) {
                        completion(Result.success(translated))
                        return
                    }
                    val region = regions[index]
                    onStatus("Đang dịch trên thiết bị ${index + 1}/${regions.size}…")
                    translator.translate(region.source)
                        .addOnSuccessListener { text ->
                            translated += region.copy(translation = text)
                            translateAt(index + 1)
                        }
                        .addOnFailureListener { error -> completion(Result.failure(error)) }
                }
                translateAt(0)
            }
    }

    private fun mlKitLanguage(tag: String): String? = when (tag.substringBefore('-').lowercase()) {
        "vi" -> TranslateLanguage.VIETNAMESE
        "en" -> TranslateLanguage.ENGLISH
        "ja" -> TranslateLanguage.JAPANESE
        "ko" -> TranslateLanguage.KOREAN
        "th" -> TranslateLanguage.THAI
        "fr" -> TranslateLanguage.FRENCH
        "es" -> TranslateLanguage.SPANISH
        "de" -> TranslateLanguage.GERMAN
        "id" -> TranslateLanguage.INDONESIAN
        else -> null
    }
}
