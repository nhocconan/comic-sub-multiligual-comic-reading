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
import android.widget.AdapterView
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
    private lateinit var backButton: Button
    private lateinit var forwardButton: Button
    private lateinit var reloadButton: Button
    private lateinit var menuButton: Button
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var translateButton: Button
    private lateinit var toolbar: LinearLayout
    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val broker = BrokerClient()
    private val byoProvider = ByoProviderClient()
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
        backButton = toolbarButton("‹", t("Go back", "Quay lại")) {
            if (webView.canGoBack()) webView.goBack()
        }
        forwardButton = toolbarButton("›", t("Go forward", "Đi tới")) {
            if (webView.canGoForward()) webView.goForward()
        }
        reloadButton = toolbarButton("↻", t("Reload", "Tải lại")) { webView.reload() }
        address = EditText(this).apply {
            setSingleLine(true)
            minWidth = 0
            hint = t("Paste a chapter URL", "Dán link chapter")
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
        languageButton = toolbarButton(
            languageLabel(settings.targetLanguage),
            t("Choose translation language", "Chọn ngôn ngữ dịch"),
        ) {
            showLanguageMenu(it)
        }
        menuButton = toolbarButton("•••", t("Open menu", "Mở menu")) { showMainMenu(it) }
        toolbar.addView(backButton)
        toolbar.addView(forwardButton)
        toolbar.addView(reloadButton)
        toolbar.addView(address, LinearLayout.LayoutParams(0, dp(46), 1f).apply {
            marginStart = dp(5)
            marginEnd = dp(5)
        })
        toolbar.addView(languageButton)
        toolbar.addView(menuButton)
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
            text = t("Ready", "Sẵn sàng")
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
            text = t("✦  Translate", "✦  Dịch")
            contentDescription = t("Translate comic images", "Dịch ảnh truyện")
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
            userAgentString = "$userAgentString MangaSubReader/0.3"
            safeBrowsingEnabled = true
        }
        webView.isVerticalScrollBarEnabled = false
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return if (uri.scheme == "http" || uri.scheme == "https") {
                    false
                } else {
                    Toast.makeText(
                        this@MainActivity,
                        t("Manga Sub only opens HTTP(S) URLs.", "Manga Sub chỉ mở URL HTTP(S)."),
                        Toast.LENGTH_SHORT,
                    ).show()
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                statusText(t("Opening page safely…", "Đang mở trang an toàn…"), busy = true)
                resumeOfferedFor = ""
                stopAfterCurrent.set(true)
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                address.setText(url)
                statusText(
                    t(
                        "Finding comic images — no data has been sent.",
                        "Đang tìm ảnh truyện — chưa gửi dữ liệu đi.",
                    ),
                    busy = true,
                )
                discover { candidates ->
                    statusText(
                        if (candidates.isEmpty()) {
                            t("No suitable comic images found.", "Chưa tìm thấy ảnh truyện phù hợp.")
                        } else {
                            t(
                                "${candidates.size} comic images ready.",
                                "${candidates.size} ảnh truyện sẵn sàng.",
                            )
                        },
                    )
                    maybeOfferResume(url)
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                super.onReceivedTitle(view, title)
                if (!title.isNullOrBlank()) {
                    webView.contentDescription = t("Reading $title", "Đang đọc $title")
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }
        }
        webView.setDownloadListener { _, _, _, _, _ ->
            Toast.makeText(
                this,
                t(
                    "Manga Sub does not download or export chapters.",
                    "Manga Sub không tải hoặc xuất chapter.",
                ),
                Toast.LENGTH_LONG,
            ).show()
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
        val documentLanguage = if (settings.uiLanguage == "vi") "vi" else "en"
        val eyebrow = t("Manga Sub Reader", "Trình đọc Manga Sub")
        val headline = t(
            "Read the original.<br>Translate in place.",
            "Đọc nguyên bản.<br>Dịch ngay tại chỗ.",
        )
        val description = t(
            "Paste a chapter URL into the address bar. Manga Sub only processes images you explicitly select and always keeps the originals available.",
            "Dán link chapter vào thanh địa chỉ. Manga Sub chỉ xử lý ảnh bạn chủ động chọn và luôn giữ ảnh gốc sẵn sàng.",
        )
        val footnote = t(
            "Choose a translation route when needed · No crawling or chapter downloads",
            "Chọn tuyến dịch khi cần · Không crawl hoặc tải chapter",
        )
        val html = """
            <!doctype html><html lang="$documentLanguage"><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              *{box-sizing:border-box}body{margin:0;background:#090907;color:#fff7e5;font:16px -apple-system,BlinkMacSystemFont,Roboto,sans-serif;min-height:100vh;display:grid;place-items:center}
              main{width:min(620px,88vw);padding:40px 0 120px}b{display:block;color:#e6b85c;font-size:14px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:28px}
              h1{font-size:clamp(42px,12vw,88px);line-height:.93;letter-spacing:-.06em;margin:0 0 24px}p{color:#b7b3a8;line-height:1.6;max-width:480px}
              hr{border:0;border-top:1px solid #343229;margin:40px 0 24px}small{color:#7d796f}
            </style><main><b>$eyebrow</b><h1>$headline</h1>
            <p>$description</p>
            <hr><small>$footnote</small></main></html>
        """.trimIndent()
        webView.loadDataWithBaseURL("https://home.comicsub.invalid/", html, "text/html", "utf-8", null)
        statusText(t("Paste a chapter URL to start reading.", "Dán link chapter để bắt đầu đọc."))
    }

    private fun openUrl(value: String) {
        val normalized = ReaderPolicy.normalizedWebUrl(value)
        if (normalized == null) {
            Toast.makeText(this, t("Invalid URL.", "Link không hợp lệ."), Toast.LENGTH_SHORT).show()
            return
        }
        stopAfterCurrent.set(true)
        webView.loadUrl(normalized)
    }

    private fun showTranslateMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add(0, MENU_TRANSLATE_CURRENT, 0, t("Translate current", "Dịch phần đang đọc"))
            menu.add(0, MENU_TRANSLATE_ALL, 1, t("Translate all loaded images", "Dịch toàn bộ ảnh đã tải"))
            menu.add(0, MENU_TOGGLE_ORIGINALS, 2, t("Show/hide originals", "Hiện/ẩn ảnh gốc"))
            if (activeJobId != null) {
                menu.add(0, MENU_STOP_AFTER_CURRENT, 3, t("Stop after this image", "Dừng sau ảnh này"))
            }
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    MENU_TRANSLATE_CURRENT -> translateCurrent()
                    MENU_TRANSLATE_ALL -> translateAll()
                    MENU_TOGGLE_ORIGINALS ->
                        webView.evaluateJavascript(ReaderScripts.revealOriginal, null)
                    MENU_STOP_AFTER_CURRENT -> {
                        stopAfterCurrent.set(true)
                        statusText(t("Will stop after the current image.", "Sẽ dừng sau ảnh đang xử lý."))
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
                statusText(t("No comic image found on this page.", "Không tìm thấy ảnh truyện trong trang."))
                return@discover
            }
            chooseRouteThen { runQueue(listOf(current)) }
        }
    }

    private fun translateAll() {
        discover { candidates ->
            if (candidates.isEmpty()) {
                statusText(t("No comic images to translate.", "Không có ảnh truyện để dịch."))
                return@discover
            }
            val frozen = candidates.take(ReaderPolicy.MAX_BATCH_IMAGES)
            val batchSize = minOf(50, frozen.size)
            AlertDialog.Builder(this)
                .setTitle(
                    t(
                        "Translate ${frozen.size} images loaded on this page",
                        "Dịch ${frozen.size} ảnh đã tải trong trang này",
                    ),
                )
                .setMessage(
                    t(
                        "Images loaded later as you scroll wait for the next batch and never generate costs automatically.\n\n" +
                            "Manga Sub processes up to 50 images per batch; the first batch contains $batchSize images.",
                        "Ảnh xuất hiện thêm khi bạn cuộn sẽ chờ ở đợt kế tiếp và không tự phát sinh chi phí.\n\n" +
                            "Manga Sub xử lý theo đợt tối đa 50 ảnh; đợt đầu có $batchSize ảnh.",
                    ),
                )
                .setNegativeButton(t("Translate as I read", "Dịch khi đọc"), null)
                .setPositiveButton(t("Translate ${frozen.size} images", "Dịch ${frozen.size} ảnh")) { _, _ ->
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
            t(
                "On this device — OCR and translation with ML Kit",
                "Trên thiết bị — OCR và dịch bằng ML Kit",
            ),
            t(
                "Manga Sub Cloud — only OCR text and coordinates are sent",
                "Manga Sub Cloud — chỉ gửi chữ OCR và tọa độ",
            ),
            t(
                "Your API key — local OCR; only text and coordinates leave",
                "API key của bạn — OCR local; chỉ chữ và tọa độ rời máy",
            ),
        )
        AlertDialog.Builder(this)
            .setTitle(t("How should this page be translated?", "Cách dịch trang này"))
            .setSingleChoiceItems(routes, 0, null)
            .setNegativeButton(t("Cancel", "Hủy"), null)
            .setPositiveButton(t("Start translating", "Bắt đầu dịch")) { dialog, _ ->
                val selected = (dialog as AlertDialog).listView.checkedItemPosition
                settings = settings.copy(route = when (selected) {
                    0 -> "device"
                    1 -> "managed"
                    else -> "byo"
                })
                store.save(settings)
                action()
            }
            .show()
    }

    private fun runQueue(candidates: List<ComicCandidate>) {
        if (activeJobId != null) {
            Toast.makeText(
                this,
                t("A translation queue is already running.", "Một hàng đợi đang chạy."),
                Toast.LENGTH_SHORT,
            ).show()
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
                if (settings.route == "byo") {
                    runByoQueueBlocking(candidates, documentUrl)
                    mainHandler.post {
                        statusText(
                            t(
                                "Completed $activeQueueDone/$activeQueueTotal images.",
                                "Đã hoàn tất $activeQueueDone/$activeQueueTotal ảnh.",
                            ),
                        )
                    }
                    return@execute
                }
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
                        statusText(
                            t(
                                "Fetching image ${position + 1}/${candidates.size}…",
                                "Đang lấy ảnh ${position + 1}/${candidates.size}…",
                            ),
                            busy = true,
                        )
                    }
                    val asset = broker.downloadCandidate(candidate, documentUrl)
                    mainHandler.post {
                        statusText(
                            t(
                                "Running local OCR ${position + 1}/${candidates.size}…",
                                "Đang OCR local ${position + 1}/${candidates.size}…",
                            ),
                            busy = true,
                        )
                    }
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
                        mainHandler.post {
                            statusText(
                                t(
                                    "Sending OCR text ${position + 1}/${candidates.size}…",
                                    "Đang gửi chữ OCR ${position + 1}/${candidates.size}…",
                                ),
                                busy = true,
                            )
                        }
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
                            if (receipt.regions.isEmpty()) {
                                t(
                                    "Image ${position + 1}: no translatable text found.",
                                    "Ảnh ${position + 1}: không phát hiện chữ cần dịch.",
                                )
                            } else {
                                t(
                                    "Translated ${position + 1}/${candidates.size} · ${routeLabel(settings.route)}",
                                    "Đã dịch ${position + 1}/${candidates.size} · ${routeLabel(settings.route)}",
                                )
                            },
                        )
                    }
                    if (stopAfterCurrent.get()) break
                }
                mainHandler.post {
                    val stopped = stopAfterCurrent.get() && activeQueueDone < activeQueueTotal
                    statusText(
                        if (stopped) {
                            t(
                                "Stopped · $activeQueueDone/$activeQueueTotal images completed.",
                                "Đã dừng · $activeQueueDone/$activeQueueTotal ảnh hoàn tất.",
                            )
                        } else {
                            t(
                                "Completed $activeQueueDone/$activeQueueTotal images.",
                                "Đã hoàn tất $activeQueueDone/$activeQueueTotal ảnh.",
                            )
                        },
                    )
                    maybeAskResearchConsent()
                }
            } catch (error: Throwable) {
                val currentJob = activeJobId
                if (currentJob != null) broker.cancel(settings, currentJob)
                mainHandler.post {
                    val message = userFacingError(error)
                    statusText(t("Translation failed: $message", "Chưa dịch được: $message"))
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
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

    private fun runByoQueueBlocking(
        candidates: List<ComicCandidate>,
        documentUrl: String,
    ) {
        val pages = mutableListOf<Pair<ComicCandidate, OnDeviceOcrPage>>()
        for ((position, candidate) in candidates.withIndex()) {
            if (stopAfterCurrent.get() && position > 0) break
            mainHandler.post {
                progress.progress = ((position.toDouble() / candidates.size) * 45).toInt()
                statusText(
                    t(
                        "Local OCR ${position + 1}/${candidates.size} — images stay on this device…",
                        "OCR local ${position + 1}/${candidates.size} — ảnh luôn ở thiết bị…",
                    ),
                    busy = true,
                )
            }
            val asset = broker.downloadCandidate(candidate, documentUrl)
            pages += candidate to deviceOcr.recognizeBlocking(asset)
        }
        mainHandler.post {
            progress.progress = 55
            statusText(
                t(
                    "Sending one text-only batch to ${providerLabel(settings.byoProvider)}…",
                    "Đang gửi một batch chỉ có chữ tới ${providerLabel(settings.byoProvider)}…",
                ),
                busy = true,
            )
        }
        val result = byoProvider.translatePages(settings, pages)
        pages.forEachIndexed { index, (candidate, page) ->
            val regions = result.regionsByCandidate[candidate.id].orEmpty()
            val receipt = JobReceipt(
                jobId = "byo-${java.util.UUID.randomUUID()}",
                batchId = "byo-text-batch",
                status = "SETTLED",
                requestedModel = settings.byoModel.ifBlank { result.model },
                resolvedModel = result.model,
                locus = "byo",
                diagnosticId = "byo-${java.util.UUID.randomUUID()}",
                regions = regions,
                sourceRegions = page.regions,
            )
            lastReceipt = receipt
            activeQueueDone = index + 1
            val json = JSONArray().apply { regions.forEach { put(it.toJson()) } }
            mainHandler.post {
                webView.evaluateJavascript(
                    ReaderScripts.attachOverlay(candidate.id, json.toString()),
                    null,
                )
                progress.progress = 55 + (((index + 1).toDouble() / pages.size) * 45).toInt()
                statusText(
                    t(
                        "Translated ${index + 1}/${pages.size} · Your API key",
                        "Đã dịch ${index + 1}/${pages.size} · API key của bạn",
                    ),
                    busy = index + 1 < pages.size,
                )
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
                onStatus = { message -> statusText(localizeDeviceStatus(message), busy = true) },
            ) {
                result = it
                lock.countDown()
            }
        }
        if (!lock.await(120, java.util.concurrent.TimeUnit.SECONDS)) {
            throw IllegalStateException(
                t("On-device translation timed out.", "Dịch trên thiết bị quá thời gian."),
            )
        }
        return result?.getOrThrow() ?: throw IllegalStateException(
            t("No on-device translation result was returned.", "Không có kết quả dịch trên thiết bị."),
        )
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
            .setTitle(
                t(
                    "Continue ${saved.title.ifBlank { "this chapter" }}?",
                    "Tiếp tục ${saved.title.ifBlank { "chapter này" }}?",
                ),
            )
            .setMessage(
                t(
                    "You stopped at image ${saved.ordinal + 1}.",
                    "Bạn đã đọc đến ảnh ${saved.ordinal + 1}.",
                ),
            )
            .setNegativeButton(t("Start over", "Từ đầu"), null)
            .setPositiveButton(t("Continue", "Tiếp tục")) { _, _ ->
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
            .setTitle(
                t(
                    "Use familiar character names?",
                    "Dùng tên nhân vật quen thuộc hơn?",
                ),
            )
            .setMessage(
                t(
                    "Manga Sub can research the series name and your selected language using vetted sources.\n\n" +
                        "Page images, OCR content, chapter URLs, and reading history are never sent for research.",
                    "Manga Sub có thể tra tên truyện và ngôn ngữ bạn chọn từ nguồn đã kiểm duyệt.\n\n" +
                        "Không gửi ảnh trang, nội dung OCR, URL chapter hay lịch sử đọc.",
                ),
            )
            .setNegativeButton(t("On device only", "Chỉ dùng trên máy")) { _, _ ->
                settings = settings.copy(researchConsent = false)
                store.save(settings)
            }
            .setPositiveButton(t("Use research sources", "Dùng nguồn tra cứu")) { _, _ ->
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

    private fun showUiLanguageMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add(0, UI_LANGUAGE_ENGLISH, 0, "English")
            menu.add(0, UI_LANGUAGE_VIETNAMESE, 1, "Tiếng Việt")
            setOnMenuItemClickListener { item ->
                val nextLanguage = when (item.itemId) {
                    UI_LANGUAGE_VIETNAMESE -> "vi"
                    else -> "en"
                }
                if (settings.uiLanguage != nextLanguage) {
                    settings = settings.copy(uiLanguage = nextLanguage)
                    store.save(settings)
                    refreshInterfaceLanguage()
                }
                true
            }
            show()
        }
    }

    private fun refreshInterfaceLanguage() {
        backButton.contentDescription = t("Go back", "Quay lại")
        forwardButton.contentDescription = t("Go forward", "Đi tới")
        reloadButton.contentDescription = t("Reload", "Tải lại")
        menuButton.contentDescription = t("Open menu", "Mở menu")
        address.hint = t("Paste a chapter URL", "Dán link chapter")
        languageButton.contentDescription =
            t("Choose translation language", "Chọn ngôn ngữ dịch")
        translateButton.text = t("✦  Translate", "✦  Dịch")
        translateButton.contentDescription = t("Translate comic images", "Dịch ảnh truyện")

        if (
            webView.url?.contains("home.comicsub.invalid") == true ||
            address.text.toString().contains("home.comicsub.invalid")
        ) {
            showHome()
        } else {
            statusText(
                t(
                    "English interface · ${routeLabel(settings.route)}",
                    "Giao diện tiếng Việt · ${routeLabel(settings.route)}",
                ),
            )
        }
    }

    private fun showMainMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add(0, MENU_HISTORY, 0, t("Reading history", "Lịch sử đọc"))
            menu.add(0, MENU_SETTINGS, 1, t("Translation settings", "Cài đặt dịch"))
            menu.add(0, MENU_UI_LANGUAGE, 2, t("App language", "Ngôn ngữ ứng dụng"))
            menu.add(
                0,
                MENU_PRIVATE,
                3,
                if (settings.privateSession) {
                    t("Turn off private session", "Tắt phiên riêng tư")
                } else {
                    t("Turn on private session", "Bật phiên riêng tư")
                },
            )
            menu.add(0, MENU_RECEIPT, 4, t("Latest job details", "Chi tiết job gần nhất"))
            menu.add(0, MENU_CLEAR_OVERLAYS, 5, t("Clear translations", "Xóa lớp dịch"))
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    MENU_HISTORY -> showHistory()
                    MENU_SETTINGS -> showSettings()
                    MENU_UI_LANGUAGE -> showUiLanguageMenu(anchor)
                    MENU_PRIVATE -> togglePrivate()
                    MENU_RECEIPT -> showReceipt()
                    MENU_CLEAR_OVERLAYS ->
                        webView.evaluateJavascript(ReaderScripts.clearOverlays, null)
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
        val endpoint = field(t("Server endpoint", "Địa chỉ server"), settings.endpoint)
        val token = field(
            if (settings.authKey.isBlank()) {
                t("Cloud auth token", "Token xác thực cloud")
            } else {
                t("Cloud auth token saved — type to replace", "Đã lưu token cloud — nhập để thay")
            },
            "",
            password = true,
        )
        val model = field(t("Model", "Model"), settings.model)
        val route = Spinner(this)
        val routeLabels = listOf(
            t("Ask every time", "Hỏi mỗi lần"),
            t("On this device", "Trên thiết bị"),
            "Manga Sub Cloud",
            t("Your API key", "API key của bạn"),
        )
        route.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, routeLabels)
        val routeValues = listOf("ask", "device", "managed", "byo")
        route.setSelection(routeValues.indexOf(settings.route).coerceAtLeast(0))
        val provider = Spinner(this)
        val providerValues = listOf("gemini", "openai", "anthropic", "openai-compatible")
        val providerLabels = listOf(
            "Google Gemini",
            "OpenAI",
            "Anthropic Claude",
            t("OpenAI-compatible", "Tương thích OpenAI"),
        )
        provider.adapter =
            ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, providerLabels)
        provider.setSelection(providerValues.indexOf(settings.byoProvider).coerceAtLeast(0))
        val byoBaseUrl = field(
            t("API base URL (OpenAI-compatible)", "API base URL (tương thích OpenAI)"),
            settings.byoBaseUrl,
        )
        val byoKey = field(
            if (settings.byoApiKey.isBlank()) {
                t("Provider API key", "API key của provider")
            } else {
                t("API key saved securely — type to replace", "API key đã lưu bảo mật — nhập để thay")
            },
            "",
            password = true,
        )
        val byoModel = field(
            t("Provider model — refresh to discover", "Model provider — refresh để lấy mới"),
            settings.byoModel,
        )
        val refreshModels = Button(this).apply {
            text = t("Refresh provider models", "Lấy danh sách model mới")
            isAllCaps = false
        }
        val clearByoKey = Button(this).apply {
            text = t("Remove saved provider key", "Xóa API key đã lưu")
            isAllCaps = false
            visibility = if (settings.byoApiKey.isBlank()) View.GONE else View.VISIBLE
        }
        fun updateProviderFields() {
            val compatible = providerValues[provider.selectedItemPosition] == "openai-compatible"
            byoBaseUrl.visibility = if (compatible) View.VISIBLE else View.GONE
        }
        provider.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) =
                updateProviderFields()
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        updateProviderFields()
        layout.addView(label(t("Processing route", "Nơi xử lý")))
        layout.addView(route)
        layout.addView(endpoint)
        layout.addView(token)
        layout.addView(model)
        layout.addView(label(t("Your API key", "API key của bạn")))
        layout.addView(provider)
        layout.addView(byoBaseUrl)
        layout.addView(byoKey)
        layout.addView(byoModel)
        layout.addView(refreshModels)
        layout.addView(clearByoKey)
        layout.addView(TextView(this).apply {
            text = "Copyright © 2026 nhocconan"
            textSize = 12f
            setTextColor(textMuted)
            setPadding(0, dp(18), 0, dp(18))
            setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://x.com/nhocconan")))
            }
            contentDescription = t("Copyright by nhocconan", "Bản quyền thuộc về nhocconan")
        })
        val scroll = ScrollView(this).apply { addView(layout) }
        AlertDialog.Builder(this)
            .setTitle(t("Translation settings", "Cài đặt dịch"))
            .setView(scroll)
            .setNegativeButton(t("Cancel", "Hủy"), null)
            .setPositiveButton(t("Save", "Lưu"), null)
            .create()
            .also { dialog ->
                dialog.setOnShowListener {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val nextEndpoint = endpoint.text.toString().trimEnd('/')
                        if (!ReaderPolicy.validEndpoint(nextEndpoint)) {
                            endpoint.error = t(
                                "Use HTTPS, or HTTP for a local/private server.",
                                "Dùng HTTPS hoặc HTTP cho server local/private.",
                            )
                            return@setOnClickListener
                        }
                        val nextProvider = providerValues[provider.selectedItemPosition]
                        val nextBaseUrl = byoBaseUrl.text.toString().trimEnd('/')
                        if (!ReaderPolicy.validByoBaseUrl(nextProvider, nextBaseUrl)) {
                            byoBaseUrl.error = t(
                                "Use HTTPS; local OpenAI-compatible HTTP is loopback-only.",
                                "Dùng HTTPS; HTTP local tương thích OpenAI chỉ dành cho loopback.",
                            )
                            return@setOnClickListener
                        }
                        settings = settings.copy(
                            endpoint = nextEndpoint,
                            authKey = token.text.toString().ifBlank { settings.authKey },
                            model = model.text.toString().ifBlank { ReaderPolicy.DEFAULT_MODEL },
                            route = routeValues[route.selectedItemPosition],
                            byoProvider = nextProvider,
                            byoBaseUrl = nextBaseUrl,
                            byoModel = byoModel.text.toString().trim(),
                            byoApiKey = byoKey.text.toString().ifBlank { settings.byoApiKey },
                        )
                        store.save(settings)
                        statusText("${languageLabel(settings.targetLanguage)} · ${routeLabel(settings.route)}")
                        dialog.dismiss()
                    }
                }
                dialog.show()
                clearByoKey.setOnClickListener {
                    store.clearByoApiKey()
                    settings = settings.copy(byoApiKey = "")
                    byoKey.setText("")
                    byoKey.hint = t("Provider API key", "API key của provider")
                    clearByoKey.visibility = View.GONE
                    Toast.makeText(
                        this,
                        t("Saved provider key removed.", "Đã xóa API key."),
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                refreshModels.setOnClickListener {
                    val currentProvider = providerValues[provider.selectedItemPosition]
                    val temporary = settings.copy(
                        byoProvider = currentProvider,
                        byoBaseUrl = byoBaseUrl.text.toString().trimEnd('/'),
                        byoApiKey = byoKey.text.toString().ifBlank { settings.byoApiKey },
                    )
                    refreshModels.isEnabled = false
                    refreshModels.text = t("Fetching models…", "Đang lấy model…")
                    worker.execute {
                        runCatching { byoProvider.listModels(temporary) }
                            .onSuccess { models ->
                                mainHandler.post {
                                    refreshModels.isEnabled = true
                                    refreshModels.text =
                                        t("Refresh provider models", "Lấy danh sách model mới")
                                    if (models.isEmpty()) {
                                        Toast.makeText(
                                            this,
                                            t("No text models were returned.", "Provider không trả model văn bản."),
                                            Toast.LENGTH_LONG,
                                        ).show()
                                    } else {
                                        val recommended =
                                            byoProvider.recommendedModel(models, currentProvider)
                                        val labels = models.map {
                                            if (it.id == recommended) "${it.id} · recommended" else it.id
                                        }.toTypedArray()
                                        AlertDialog.Builder(this)
                                            .setTitle(t("Choose a live model", "Chọn model hiện có"))
                                            .setItems(labels) { _, index ->
                                                byoModel.setText(models[index].id)
                                            }
                                            .setNegativeButton(t("Close", "Đóng"), null)
                                            .show()
                                    }
                                }
                            }
                            .onFailure { error ->
                                mainHandler.post {
                                    refreshModels.isEnabled = true
                                    refreshModels.text =
                                        t("Refresh provider models", "Lấy danh sách model mới")
                                    Toast.makeText(
                                        this,
                                        userFacingError(error),
                                        Toast.LENGTH_LONG,
                                    ).show()
                                }
                            }
                    }
                }
            }
    }

    private fun showHistory() {
        val history = store.history()
        if (history.isEmpty()) {
            AlertDialog.Builder(this).setTitle(t("Reading history", "Lịch sử đọc"))
                .setMessage(t("No chapters have been saved yet.", "Chưa có chapter nào được lưu."))
                .setPositiveButton(t("Close", "Đóng"), null).show()
            return
        }
        val labels = history.map {
            t(
                "${it.title.ifBlank { Uri.parse(it.url).host ?: it.url }}\nImage ${it.ordinal + 1}",
                "${it.title.ifBlank { Uri.parse(it.url).host ?: it.url }}\nẢnh ${it.ordinal + 1}",
            )
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(t("Continue reading", "Tiếp tục đọc"))
            .setItems(labels) { _, index -> openUrl(history[index].url) }
            .setNegativeButton(t("Close", "Đóng"), null)
            .setNeutralButton(t("Clear history", "Xóa lịch sử")) { _, _ -> store.clearHistory() }
            .show()
    }

    private fun showReceipt() {
        val receipt = lastReceipt
        if (receipt == null) {
            Toast.makeText(
                this,
                t("No jobs in this session yet.", "Chưa có job nào trong phiên này."),
                Toast.LENGTH_SHORT,
            ).show()
            return
        }
        val locus = when (receipt.locus) {
            "managed" -> "Manga Sub Cloud"
            "paired" -> t("Private server", "Server riêng")
            "device" -> t("On this device", "Trên thiết bị")
            "byo" -> t(
                "Your API key · ${providerLabel(settings.byoProvider)}",
                "API key của bạn · ${providerLabel(settings.byoProvider)}",
            )
            else -> receipt.locus
        }
        AlertDialog.Builder(this)
            .setTitle(t("Latest image details", "Chi tiết ảnh gần nhất"))
            .setMessage(
                t(
                    "Processed by: $locus\n" +
                        "Translation: ${receipt.resolvedModel.ifBlank { "ML Kit on-device engine" }}\n" +
                        "Requested / resolved: ${if (receipt.requestedModel == receipt.resolvedModel) "matched" else "device route"}\n" +
                        "Diagnostic ID: ${ReaderPolicy.safeDiagnosticId(receipt.diagnosticId)}\n" +
                        "Translated regions: ${receipt.regions.size}",
                    "Xử lý tại: $locus\n" +
                        "Translation: ${receipt.resolvedModel.ifBlank { "ML Kit trên thiết bị" }}\n" +
                        "Yêu cầu / thực tế: ${if (receipt.requestedModel == receipt.resolvedModel) "khớp" else "tuyến thiết bị"}\n" +
                        "Diagnostic ID: ${ReaderPolicy.safeDiagnosticId(receipt.diagnosticId)}\n" +
                        "Vùng dịch: ${receipt.regions.size}",
                ),
            )
            .setPositiveButton(t("Close", "Đóng"), null)
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
            statusText(
                t(
                    "Private session · Manga Sub does not intentionally store reading data.",
                    "Phiên riêng tư · Manga Sub không cố ý lưu dữ liệu đọc.",
                ),
            )
        } else {
            statusText(t("Private session turned off.", "Đã tắt phiên riêng tư."))
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
        "device" -> t("On-device OCR + translation", "OCR + dịch trên thiết bị")
        "paired" -> t("Private server · local OCR", "Server riêng · OCR local")
        "managed" -> t("Manga Sub Cloud · local OCR", "Manga Sub Cloud · OCR local")
        "byo" -> t("Your API key · local OCR", "API key của bạn · OCR local")
        else -> t("Ask before sending", "Hỏi trước khi gửi")
    }

    private fun localizeDeviceStatus(message: String): String {
        if (settings.uiLanguage == "vi") return message
        return when {
            message.startsWith("Đang chuẩn bị gói ngôn ngữ") ->
                "Preparing the on-device language pack…"
            message.startsWith("Đang dịch ") -> {
                val count = Regex("\\d+").find(message)?.value ?: ""
                "Translating $count text regions in parallel on this device…"
            }
            else -> message
        }
    }

    private fun userFacingError(error: Throwable): String {
        if (error is ByoProviderException) {
            return if (settings.uiLanguage == "vi") error.vietnamese else error.english
        }
        val raw = error.message.orEmpty().trim()
        if (raw.isBlank()) return t("Unknown error", "Lỗi không xác định")
        if (settings.uiLanguage == "vi") return raw
        return when {
            raw.contains("Ngôn ngữ này chưa được ML Kit hỗ trợ") ->
                "This language is not supported by ML Kit."
            raw.contains("Không giải mã được ảnh") ->
                "The image could not be decoded for on-device OCR."
            raw.contains("Định dạng ảnh") ->
                "This image format is not supported."
            raw.contains("OCR trên thiết bị quá thời gian") ->
                "On-device OCR timed out."
            raw.contains("OCR trên thiết bị không trả kết quả") ->
                "On-device OCR returned no result."
            raw.contains("Không tải được ảnh") ->
                raw.replace("Không tải được ảnh", "Could not download the image")
            raw.contains("Ảnh vượt giới hạn") ->
                "The image exceeds the 32 MB limit."
            raw.contains("Endpoint không hợp lệ") ->
                "The server endpoint is invalid."
            raw.contains("Job dịch quá thời gian") ->
                "Cloud translation timed out."
            else -> raw
        }
    }

    private fun providerLabel(provider: String): String = when (provider) {
        "gemini" -> "Google Gemini"
        "openai" -> "OpenAI"
        "anthropic" -> "Anthropic Claude"
        else -> t("OpenAI-compatible", "Tương thích OpenAI")
    }

    private fun t(english: String, vietnamese: String): String =
        if (::settings.isInitialized && settings.uiLanguage == "vi") vietnamese else english

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

    private companion object {
        const val MENU_TRANSLATE_CURRENT = 100
        const val MENU_TRANSLATE_ALL = 101
        const val MENU_TOGGLE_ORIGINALS = 102
        const val MENU_STOP_AFTER_CURRENT = 103
        const val MENU_HISTORY = 200
        const val MENU_SETTINGS = 201
        const val MENU_UI_LANGUAGE = 202
        const val MENU_PRIVATE = 203
        const val MENU_RECEIPT = 204
        const val MENU_CLEAR_OVERLAYS = 205
        const val UI_LANGUAGE_ENGLISH = 300
        const val UI_LANGUAGE_VIETNAMESE = 301
    }
}
