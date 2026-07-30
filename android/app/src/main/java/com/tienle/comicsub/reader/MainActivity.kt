package com.tienle.comicsub.reader

import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

class MainActivity : ComponentActivity() {
    private val surface = Color.rgb(17, 17, 15)
    private val raised = Color.rgb(31, 30, 26)
    private val textPrimary = Color.rgb(255, 247, 229)
    private val textMuted = Color.rgb(183, 179, 168)
    private val accent = Color.rgb(230, 184, 92)

    private lateinit var store: ReaderStore
    private lateinit var settings: ReaderSettings
    private lateinit var webView: WebView
    private lateinit var address: EditText
    private lateinit var languageButton: Button
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var translateButton: Button
    private lateinit var toolbar: LinearLayout
    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val broker = BrokerClient()
    private val deviceOcr = OnDeviceOcr()
    private lateinit var deviceTranslator: OnDeviceTranslator
    private val stopAfterCurrent = AtomicBoolean(false)
    private var activeJobId: String? = null
    private var activeQueueTotal = 0
    private var activeQueueDone = 0
    private var lastReceipt: JobReceipt? = null
    private var lastScrollY = 0
    private var resumeOfferedFor = ""

    private val progressSaver = object : Runnable {
        override fun run() {
            captureProgress()
            mainHandler.postDelayed(this, 10_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = surface
        window.navigationBarColor = surface
        store = ReaderStore(this)
        settings = store.settings()
        deviceTranslator = OnDeviceTranslator(this)
        buildInterface()
        configureWebView()
        mainHandler.postDelayed(progressSaver, 10_000)

        val incoming = intent?.dataString
        if (!incoming.isNullOrBlank()) openUrl(incoming)
        else showHome()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let(::openUrl)
    }

    private fun buildInterface() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(surface)
        }
        toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(5), dp(8), dp(5))
            setBackgroundColor(surface)
        }
        val back = toolbarButton("‹", "Quay lại") {
            if (webView.canGoBack()) webView.goBack()
        }
        val forward = toolbarButton("›", "Đi tới") {
            if (webView.canGoForward()) webView.goForward()
        }
        val reload = toolbarButton("↻", "Tải lại") { webView.reload() }
        address = EditText(this).apply {
            setSingleLine(true)
            minWidth = 0
            hint = "Dán link chapter"
            setHintTextColor(textMuted)
            setTextColor(textPrimary)
            textSize = 14f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            background = roundedBackground(raised, 0, 12f)
            setPadding(dp(12), 0, dp(12), 0)
            setOnEditorActionListener { _, _, event ->
                if (event == null || event.keyCode == KeyEvent.KEYCODE_ENTER) {
                    openUrl(text.toString())
                    true
                } else false
            }
        }
        languageButton = toolbarButton(languageLabel(settings.targetLanguage), "Chọn ngôn ngữ đích") {
            showLanguageMenu(it)
        }
        val menu = toolbarButton("•••", "Mở menu") { showMainMenu(it) }
        toolbar.addView(back)
        toolbar.addView(forward)
        toolbar.addView(reload)
        toolbar.addView(address, LinearLayout.LayoutParams(0, dp(46), 1f).apply {
            marginStart = dp(5)
            marginEnd = dp(5)
        })
        toolbar.addView(languageButton)
        toolbar.addView(menu)
        root.addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(58)))

        val workspace = FrameLayout(this).apply { setBackgroundColor(Color.rgb(8, 8, 7)) }
        webView = WebView(this)
        workspace.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        ))

        val progressRail = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(9))
            background = roundedBackground(Color.argb(238, 31, 30, 26), Color.rgb(67, 64, 55), 13f)
        }
        status = TextView(this).apply {
            text = "Sẵn sàng"
            setTextColor(textPrimary)
            textSize = 13f
            maxLines = 2
            setTypeface(typeface, Typeface.BOLD)
        }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            visibility = View.GONE
            progressTintList = android.content.res.ColorStateList.valueOf(accent)
        }
        progressRail.addView(status, LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT))
        progressRail.addView(progress, LinearLayout.LayoutParams(dp(220), dp(3)).apply { topMargin = dp(7) })
        workspace.addView(progressRail, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.START,
        ).apply {
            leftMargin = dp(12)
            bottomMargin = dp(16)
        })

        translateButton = Button(this).apply {
            text = "✦  Dịch"
            contentDescription = "Dịch phần đang đọc"
            setTextColor(surface)
            textSize = 15f
            isAllCaps = false
            minWidth = dp(112)
            minHeight = dp(52)
            setTypeface(typeface, Typeface.BOLD)
            background = roundedBackground(accent, 0, 18f)
            elevation = dp(8).toFloat()
            setOnClickListener { showTranslateMenu(it) }
        }
        workspace.addView(translateButton, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            dp(54),
            Gravity.BOTTOM or Gravity.END,
        ).apply {
            rightMargin = dp(14)
            bottomMargin = dp(16)
        })
        root.addView(workspace, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f,
        ))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
    }

    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(
            applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0,
        )
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = !settings.privateSession
            databaseEnabled = !settings.privateSession
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            cacheMode = if (settings.privateSession) {
                android.webkit.WebSettings.LOAD_NO_CACHE
            } else {
                android.webkit.WebSettings.LOAD_DEFAULT
            }
            userAgentString = "$userAgentString ComicSubReader/0.3"
            safeBrowsingEnabled = true
        }
        webView.isVerticalScrollBarEnabled = false
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return if (uri.scheme == "http" || uri.scheme == "https") {
                    false
                } else {
                    Toast.makeText(this@MainActivity, "Comic Sub chỉ mở URL HTTP(S).", Toast.LENGTH_SHORT).show()
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                statusText("Đang mở trang an toàn…", busy = true)
                resumeOfferedFor = ""
                stopAfterCurrent.set(true)
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                address.setText(url)
                statusText("Đang tìm ảnh truyện — chưa gửi dữ liệu đi.", busy = true)
                discover { candidates ->
                    statusText(
                        if (candidates.isEmpty()) "Chưa tìm thấy ảnh truyện phù hợp."
                        else "${candidates.size} ảnh truyện sẵn sàng.",
                    )
                    maybeOfferResume(url)
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                super.onReceivedTitle(view, title)
                if (!title.isNullOrBlank()) webView.contentDescription = "Đang đọc $title"
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }
        }
        webView.setDownloadListener { _, _, _, _, _ ->
            Toast.makeText(this, "Comic Sub không tải hoặc xuất chapter.", Toast.LENGTH_LONG).show()
        }
        webView.setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
            val delta = scrollY - oldScrollY
            if (abs(delta) > dp(8)) {
                toolbar.animate()
                    .translationY(if (delta > 0) -toolbar.height.toFloat() else 0f)
                    .setDuration(160)
                    .start()
            }
            lastScrollY = scrollY
        }
    }

    private fun showHome() {
        val html = """
            <!doctype html><html lang="vi"><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              *{box-sizing:border-box}body{margin:0;background:#090907;color:#fff7e5;font:16px -apple-system,BlinkMacSystemFont,Roboto,sans-serif;min-height:100vh;display:grid;place-items:center}
              main{width:min(620px,88vw);padding:40px 0 120px}b{display:block;color:#e6b85c;font-size:14px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:28px}
              h1{font-size:clamp(42px,12vw,88px);line-height:.93;letter-spacing:-.06em;margin:0 0 24px}p{color:#b7b3a8;line-height:1.6;max-width:480px}
              hr{border:0;border-top:1px solid #343229;margin:40px 0 24px}small{color:#7d796f}
            </style><main><b>Comic Sub Reader</b><h1>Đọc nguyên bản.<br>Dịch ngay tại chỗ.</h1>
            <p>Dán link chapter vào thanh địa chỉ. Comic Sub chỉ xử lý ảnh bạn chủ động chọn và luôn giữ ảnh gốc sẵn sàng.</p>
            <hr><small>VI · Chọn tuyến dịch khi cần · Không crawl hoặc tải chapter</small></main></html>
        """.trimIndent()
        webView.loadDataWithBaseURL("https://home.comicsub.invalid/", html, "text/html", "utf-8", null)
        statusText("Dán link chapter để bắt đầu đọc.")
    }

    private fun openUrl(value: String) {
        val normalized = ReaderPolicy.normalizedWebUrl(value)
        if (normalized == null) {
            Toast.makeText(this, "Link không hợp lệ.", Toast.LENGTH_SHORT).show()
            return
        }
        stopAfterCurrent.set(true)
        webView.loadUrl(normalized)
    }

    private fun showTranslateMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add("Dịch phần đang đọc")
            menu.add("Dịch toàn bộ ảnh hiện có")
            menu.add("Hiện/ẩn ảnh gốc")
            if (activeJobId != null) menu.add("Dừng sau ảnh này")
            setOnMenuItemClickListener { item ->
                when (item.title.toString()) {
                    "Dịch phần đang đọc" -> translateCurrent()
                    "Dịch toàn bộ ảnh hiện có" -> translateAll()
                    "Hiện/ẩn ảnh gốc" -> webView.evaluateJavascript(ReaderScripts.revealOriginal, null)
                    "Dừng sau ảnh này" -> {
                        stopAfterCurrent.set(true)
                        statusText("Sẽ dừng sau ảnh đang xử lý.")
                    }
                }
                true
            }
            show()
        }
    }

    private fun translateCurrent() {
        discover { candidates ->
            val current = ReaderPolicy.currentCandidate(candidates)
            if (current == null) {
                statusText("Không tìm thấy ảnh truyện trong trang.")
                return@discover
            }
            chooseRouteThen { runQueue(listOf(current)) }
        }
    }

    private fun translateAll() {
        discover { candidates ->
            if (candidates.isEmpty()) {
                statusText("Không có ảnh truyện để dịch.")
                return@discover
            }
            val frozen = candidates.take(ReaderPolicy.MAX_BATCH_IMAGES)
            val batchSize = minOf(50, frozen.size)
            AlertDialog.Builder(this)
                .setTitle("Dịch ${frozen.size} ảnh đang tải trong trang này")
                .setMessage(
                    "Ảnh xuất hiện thêm khi bạn cuộn sẽ chờ ở đợt kế tiếp và không tự phát sinh chi phí.\n\n" +
                        "Comic Sub xử lý theo đợt tối đa 50 ảnh; đợt đầu có $batchSize ảnh.",
                )
                .setNegativeButton("Dịch khi đọc", null)
                .setPositiveButton("Dịch ${frozen.size} ảnh") { _, _ ->
                    chooseRouteThen { runQueue(frozen) }
                }
                .show()
        }
    }

    private fun chooseRouteThen(action: () -> Unit) {
        if (settings.route != "ask") {
            action()
            return
        }
        val routes = arrayOf(
            "Riêng tư trên thiết bị — OCR và dịch bằng ML Kit",
            "Server riêng — chỉ gửi chữ OCR và tọa độ",
            "Manga Sub Cloud — chỉ gửi chữ OCR và tọa độ",
        )
        AlertDialog.Builder(this)
            .setTitle("Cách dịch trang này")
            .setSingleChoiceItems(routes, 0, null)
            .setNegativeButton("Hủy", null)
            .setPositiveButton("Bắt đầu dịch") { dialog, _ ->
                val selected = (dialog as AlertDialog).listView.checkedItemPosition
                settings = settings.copy(route = when (selected) {
                    0 -> "device"
                    1 -> "paired"
                    else -> "managed"
                })
                store.save(settings)
                action()
            }
            .show()
    }

    private fun runQueue(candidates: List<ComicCandidate>) {
        if (activeJobId != null) {
            Toast.makeText(this, "Một hàng đợi đang chạy.", Toast.LENGTH_SHORT).show()
            return
        }
        stopAfterCurrent.set(false)
        activeQueueTotal = candidates.size
        activeQueueDone = 0
        val documentUrl = webView.url.orEmpty()
        val documentTitle = webView.title.orEmpty()
        progress.visibility = View.VISIBLE
        translateButton.isEnabled = false
        worker.execute {
            try {
                val deviceOnly = settings.route == "device"
                var series = if (deviceOnly) null else runCatching {
                    broker.bootstrapSeries(settings, documentTitle, documentUrl, emptyList())
                }.getOrNull()
                var glossary = series?.glossarySnapshot ?: JSONObject()
                    .put("id", "local-empty")
                    .put("version", 0)
                    .put("hash", "0".repeat(64))
                for ((position, candidate) in candidates.withIndex()) {
                    if (stopAfterCurrent.get() && position > 0) break
                    if (position > 0 && series != null) {
                        glossary = runCatching {
                            broker.getSeriesGlossary(settings, series.seriesId)
                        }.getOrDefault(glossary)
                    }
                    mainHandler.post {
                        progress.progress = ((position.toDouble() / candidates.size) * 100).toInt()
                        statusText("Đang lấy ảnh ${position + 1}/${candidates.size}…", busy = true)
                    }
                    val asset = broker.downloadCandidate(candidate, documentUrl)
                    mainHandler.post { statusText("Đang OCR local ${position + 1}/${candidates.size}…", busy = true) }
                    val recognized = deviceOcr.recognizeBlocking(asset)
                    var receipt = if (deviceOnly) {
                        JobReceipt(
                            jobId = "device-${java.util.UUID.randomUUID()}",
                            batchId = "device",
                            status = "SETTLED",
                            requestedModel = "mlkit-translation",
                            resolvedModel = "mlkit-translation",
                            locus = "device",
                            diagnosticId = "device-${java.util.UUID.randomUUID()}",
                            regions = translateOnDeviceBlocking(recognized.regions),
                            sourceRegions = recognized.regions,
                        )
                    } else {
                        mainHandler.post { statusText("Đang gửi chữ OCR ${position + 1}/${candidates.size}…", busy = true) }
                        val created = broker.createJob(
                            candidate,
                            settings,
                            documentUrl,
                            documentTitle,
                            glossary,
                            recognized,
                        )
                        activeJobId = created.jobId
                        broker.awaitReceipt(settings, created)
                    }
                    val observedAliases = (receipt.sourceRegions + receipt.regions)
                        .map { it.source }
                        .filter { it.isNotBlank() }
                    if (series != null && observedAliases.isNotEmpty()) {
                        series = runCatching {
                            broker.bootstrapSeries(
                                settings,
                                documentTitle,
                                documentUrl,
                                observedAliases,
                            )
                        }.getOrDefault(series)
                        glossary = series.glossarySnapshot
                    }
                    activeJobId = null
                    activeQueueDone = position + 1
                    lastReceipt = receipt
                    val regions = JSONArray().apply { receipt.regions.forEach { put(it.toJson()) } }
                    mainHandler.post {
                        webView.evaluateJavascript(ReaderScripts.attachOverlay(candidate.id, regions.toString()), null)
                        progress.progress = (((position + 1).toDouble() / candidates.size) * 100).toInt()
                        statusText(
                            if (receipt.regions.isEmpty()) "Ảnh ${position + 1}: không phát hiện chữ cần dịch."
                            else "Đã dịch ${position + 1}/${candidates.size} · ${routeLabel(settings.route)}",
                        )
                    }
                    if (stopAfterCurrent.get()) break
                }
                mainHandler.post {
                    val stopped = stopAfterCurrent.get() && activeQueueDone < activeQueueTotal
                    statusText(
                        if (stopped) "Đã dừng · $activeQueueDone/$activeQueueTotal ảnh hoàn tất."
                        else "Đã hoàn tất $activeQueueDone/$activeQueueTotal ảnh.",
                    )
                    maybeAskResearchConsent()
                }
            } catch (error: Throwable) {
                val currentJob = activeJobId
                if (currentJob != null) broker.cancel(settings, currentJob)
                mainHandler.post {
                    statusText("Chưa dịch được: ${error.message ?: "lỗi không xác định"}")
                    Toast.makeText(this, error.message, Toast.LENGTH_LONG).show()
                }
            } finally {
                activeJobId = null
                mainHandler.post {
                    progress.visibility = View.GONE
                    translateButton.isEnabled = true
                }
            }
        }
    }

    private fun translateOnDeviceBlocking(regions: List<OverlayRegion>): List<OverlayRegion> {
        val lock = java.util.concurrent.CountDownLatch(1)
        var result: Result<List<OverlayRegion>>? = null
        mainHandler.post {
            deviceTranslator.translate(
                regions,
                settings.targetLanguage,
                onStatus = { message -> statusText(message, busy = true) },
            ) {
                result = it
                lock.countDown()
            }
        }
        if (!lock.await(120, java.util.concurrent.TimeUnit.SECONDS)) {
            throw IllegalStateException("Dịch trên thiết bị quá thời gian.")
        }
        return result?.getOrThrow() ?: throw IllegalStateException("Không có kết quả dịch trên thiết bị.")
    }

    private fun discover(completion: (List<ComicCandidate>) -> Unit) {
        webView.evaluateJavascript(ReaderScripts.discoverCandidates) { raw ->
            val json = decodeJavaScriptString(raw)
            val candidates = runCatching { ComicCandidate.listFromJson(json) }.getOrElse { emptyList() }
            completion(candidates)
        }
    }

    private fun captureProgress() {
        if (settings.privateSession || !::webView.isInitialized || webView.url.isNullOrBlank()) return
        webView.evaluateJavascript(ReaderScripts.captureProgress) { raw ->
            val value = runCatching { JSONObject(decodeJavaScriptString(raw)) }.getOrNull()
                ?: return@evaluateJavascript
            val url = webView.url.orEmpty()
            if (!url.startsWith("http") || url.contains("home.comicsub.invalid")) return@evaluateJavascript
            store.upsert(
                ReadingProgress(
                    url = url,
                    title = webView.title.orEmpty(),
                    candidateId = value.optString("candidateId"),
                    ordinal = value.optInt("ordinal"),
                    intraImageRatio = value.optDouble("intraImageRatio"),
                    scrollRatio = value.optDouble("scrollRatio"),
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    private fun maybeOfferResume(url: String) {
        if (resumeOfferedFor == url || settings.privateSession) return
        val saved = store.history().firstOrNull { it.url == url } ?: return
        resumeOfferedFor = url
        AlertDialog.Builder(this)
            .setTitle("Tiếp tục ${saved.title.ifBlank { "chapter này" }}?")
            .setMessage("Bạn đã đọc đến ảnh ${saved.ordinal + 1}.")
            .setNegativeButton("Từ đầu", null)
            .setPositiveButton("Tiếp tục") { _, _ ->
                webView.evaluateJavascript(
                    ReaderScripts.resume(
                        saved.candidateId,
                        saved.ordinal,
                        saved.intraImageRatio,
                        saved.scrollRatio,
                    ),
                    null,
                )
            }
            .show()
    }

    private fun maybeAskResearchConsent() {
        if (settings.privateSession || settings.researchConsent != null) return
        AlertDialog.Builder(this)
            .setTitle("Dùng tên nhân vật quen thuộc hơn?")
            .setMessage(
                "Comic Sub có thể tra tên truyện và ngôn ngữ bạn chọn từ nguồn đã kiểm duyệt.\n\n" +
                    "Không gửi ảnh trang, nội dung OCR, URL chapter hay lịch sử đọc.",
            )
            .setNegativeButton("Chỉ dùng trên máy") { _, _ ->
                settings = settings.copy(researchConsent = false)
                store.save(settings)
            }
            .setPositiveButton("Dùng nguồn tra cứu") { _, _ ->
                settings = settings.copy(researchConsent = true)
                store.save(settings)
            }
            .show()
    }

    private fun showLanguageMenu(anchor: View) {
        val values = linkedMapOf(
            "vi" to "Tiếng Việt",
            "en" to "English",
            "ja" to "日本語",
            "ko" to "한국어",
            "th" to "ไทย",
            "fr" to "Français",
            "es" to "Español",
        )
        PopupMenu(this, anchor).apply {
            values.values.forEach(menu::add)
            setOnMenuItemClickListener { item ->
                val code = values.entries.first { it.value == item.title.toString() }.key
                settings = settings.copy(targetLanguage = code)
                store.save(settings)
                languageButton.text = languageLabel(code)
                statusText("${languageLabel(code)} · ${routeLabel(settings.route)}")
                true
            }
            show()
        }
    }

    private fun showMainMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add("Lịch sử đọc")
            menu.add("Cài đặt tuyến dịch")
            menu.add(if (settings.privateSession) "Tắt phiên riêng tư" else "Bật phiên riêng tư")
            menu.add("Chi tiết job gần nhất")
            menu.add("Xóa lớp dịch")
            setOnMenuItemClickListener { item ->
                when {
                    item.title == "Lịch sử đọc" -> showHistory()
                    item.title == "Cài đặt tuyến dịch" -> showSettings()
                    item.title.toString().contains("phiên riêng tư") -> togglePrivate()
                    item.title == "Chi tiết job gần nhất" -> showReceipt()
                    item.title == "Xóa lớp dịch" -> webView.evaluateJavascript(ReaderScripts.clearOverlays, null)
                }
                true
            }
            show()
        }
    }

    private fun showSettings() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(8), dp(22), 0)
        }
        val endpoint = field("Server endpoint", settings.endpoint)
        val token = field("Auth token", settings.authKey, password = true)
        val model = field("Model", settings.model)
        val route = Spinner(this)
        val routeLabels = listOf("Hỏi mỗi lần", "Trên thiết bị", "Server riêng", "Managed Cloud")
        route.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, routeLabels)
        route.setSelection(listOf("ask", "device", "paired", "managed").indexOf(settings.route).coerceAtLeast(0))
        layout.addView(label("Nơi xử lý"))
        layout.addView(route)
        layout.addView(endpoint)
        layout.addView(token)
        layout.addView(model)
        AlertDialog.Builder(this)
            .setTitle("Tuyến dịch")
            .setView(layout)
            .setNegativeButton("Hủy", null)
            .setPositiveButton("Lưu", null)
            .create()
            .also { dialog ->
                dialog.setOnShowListener {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val nextEndpoint = endpoint.text.toString().trimEnd('/')
                        if (!ReaderPolicy.validEndpoint(nextEndpoint)) {
                            endpoint.error = "Dùng HTTPS hoặc server local/private HTTP."
                            return@setOnClickListener
                        }
                        settings = settings.copy(
                            endpoint = nextEndpoint,
                            authKey = token.text.toString(),
                            model = model.text.toString().ifBlank { ReaderPolicy.DEFAULT_MODEL },
                            route = listOf("ask", "device", "paired", "managed")[route.selectedItemPosition],
                        )
                        store.save(settings)
                        statusText("${languageLabel(settings.targetLanguage)} · ${routeLabel(settings.route)}")
                        dialog.dismiss()
                    }
                }
                dialog.show()
            }
    }

    private fun showHistory() {
        val history = store.history()
        if (history.isEmpty()) {
            AlertDialog.Builder(this).setTitle("Lịch sử đọc")
                .setMessage("Chưa có chapter nào được lưu.")
                .setPositiveButton("Đóng", null).show()
            return
        }
        val labels = history.map {
            "${it.title.ifBlank { Uri.parse(it.url).host ?: it.url }}\nẢnh ${it.ordinal + 1}"
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Tiếp tục đọc")
            .setItems(labels) { _, index -> openUrl(history[index].url) }
            .setNegativeButton("Đóng", null)
            .setNeutralButton("Xóa lịch sử") { _, _ -> store.clearHistory() }
            .show()
    }

    private fun showReceipt() {
        val receipt = lastReceipt
        if (receipt == null) {
            Toast.makeText(this, "Chưa có job nào trong phiên này.", Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Chi tiết ảnh gần nhất")
            .setMessage(
                "Xử lý tại: ${receipt.locus}\n" +
                    "Translation: ${receipt.resolvedModel.ifBlank { "Apple/ML Kit device engine" }}\n" +
                    "Requested / resolved: ${if (receipt.requestedModel == receipt.resolvedModel) "matched" else "device route"}\n" +
                    "Diagnostic ID: ${ReaderPolicy.safeDiagnosticId(receipt.diagnosticId)}\n" +
                    "Vùng dịch: ${receipt.regions.size}",
            )
            .setPositiveButton("Đóng", null)
            .show()
    }

    private fun togglePrivate() {
        settings = settings.copy(privateSession = !settings.privateSession)
        store.save(settings)
        if (settings.privateSession) {
            CookieManager.getInstance().removeAllCookies(null)
            webView.clearHistory()
            webView.clearCache(true)
            WebView(this).clearFormData()
            statusText("Phiên riêng tư · Comic Sub không cố ý lưu dữ liệu đọc.")
        } else {
            statusText("Đã tắt phiên riêng tư.")
        }
        webView.settings.domStorageEnabled = !settings.privateSession
        webView.settings.databaseEnabled = !settings.privateSession
        webView.settings.cacheMode = if (settings.privateSession) {
            android.webkit.WebSettings.LOAD_NO_CACHE
        } else {
            android.webkit.WebSettings.LOAD_DEFAULT
        }
    }

    private fun statusText(value: String, busy: Boolean = false) {
        status.text = value
        if (busy) {
            progress.visibility = View.VISIBLE
            if (activeQueueTotal == 0) progress.isIndeterminate = true
        } else if (activeJobId == null) {
            progress.isIndeterminate = false
            if (!translateButton.isEnabled) return
            progress.visibility = View.GONE
        }
    }

    private fun toolbarButton(label: String, description: String, action: (View) -> Unit): Button =
        Button(this).apply {
            text = label
            contentDescription = description
            setTextColor(textPrimary)
            textSize = if (label.length <= 2) 22f else 12f
            isAllCaps = false
            minWidth = 0
            minHeight = dp(48)
            setPadding(dp(8), 0, dp(8), 0)
            layoutParams = LinearLayout.LayoutParams(
                dp(ReaderPolicy.TOOLBAR_ACTION_WIDTH_DP),
                dp(48),
            )
            background = roundedBackground(Color.TRANSPARENT, 0, 12f)
            setOnClickListener(action)
        }

    private fun field(hint: String, value: String, password: Boolean = false): EditText =
        EditText(this).apply {
            this.hint = hint
            setText(value)
            setSelectAllOnFocus(false)
            inputType = if (password) {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            } else {
                InputType.TYPE_CLASS_TEXT
            }
            minHeight = dp(52)
        }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setPadding(0, dp(8), 0, dp(4))
    }

    private fun roundedBackground(fill: Int, stroke: Int, radius: Float): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(fill)
            cornerRadius = dp(radius.toInt()).toFloat()
            if (stroke != 0) setStroke(dp(1), stroke)
        }

    private fun languageLabel(code: String): String = when (code.substringBefore('-')) {
        "vi" -> "VI"
        "en" -> "EN"
        "ja" -> "JA"
        "ko" -> "KO"
        "th" -> "TH"
        "fr" -> "FR"
        "es" -> "ES"
        else -> code.take(2).uppercase()
    }

    private fun routeLabel(route: String): String = when (route) {
        "device" -> "OCR + dịch trên thiết bị"
        "paired" -> "Server riêng · OCR local"
        "managed" -> "Manga Sub Cloud · OCR local"
        else -> "Hỏi trước khi gửi"
    }

    private fun decodeJavaScriptString(raw: String): String =
        runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(progressSaver)
        stopAfterCurrent.set(true)
        activeJobId?.let { broker.cancel(settings, it) }
        if (settings.privateSession) {
            CookieManager.getInstance().removeAllCookies(null)
            webView.clearCache(true)
            webView.clearHistory()
        }
        webView.stopLoading()
        webView.destroy()
        deviceOcr.close()
        worker.shutdownNow()
        super.onDestroy()
    }
}
