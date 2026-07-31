package com.tienle.comicsub.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicReference

class ByoProviderClientTest {
    @Test
    fun rejectsDuplicateAndIncompleteProviderRegionIds() {
        val client = ByoProviderClient()
        val expected = setOf("a", "b")

        val duplicate = runCatching {
            client.parseTranslations(
                """{"translations":[{"id":"a","text":"A"},{"id":"a","text":"B"}]}""",
                expected,
            )
        }.exceptionOrNull() as ByoProviderException
        assertEquals("BYO_OUTPUT_DUPLICATE", duplicate.code)

        val incomplete = runCatching {
            client.parseTranslations(
                """{"translations":[{"id":"a","text":"A"}]}""",
                expected,
            )
        }.exceptionOrNull() as ByoProviderException
        assertEquals("BYO_OUTPUT_INCOMPLETE", incomplete.code)
    }

    @Test
    fun liveCompatibleCatalogFiltersNonTextModelsAndRecommendsNewestTextFamily() {
        FakeHttpServer {
            """
                    {"data":[
                      {"id":"gpt-5.3-mini","created":10},
                      {"id":"gpt-5.4","created":20},
                      {"id":"image-model","created":30}
                    ]}
            """.trimIndent()
        }.use { server ->
            val client = ByoProviderClient()
            val settings = ReaderSettings(
                byoProvider = "openai-compatible",
                byoBaseUrl = "${server.baseUrl}/v1",
                byoApiKey = "",
            )
            val models = client.listModels(settings)
            assertEquals(listOf("gpt-5.3-mini", "gpt-5.4"), models.map { it.id })
            assertEquals("gpt-5.4", client.recommendedModel(models, "openai-compatible"))
        }
    }

    @Test
    fun oneTextOnlyRequestTranslatesAllLocalOcrRegionsAndPreservesGeometry() {
        val captured = AtomicReference("")
        FakeHttpServer { request ->
            captured.set(request.body)
            """
                    {"choices":[{"message":{"content":"{\"translations\":[{\"id\":\"page-1::r1\",\"text\":\"Xin chào\"},{\"id\":\"page-1::r2\",\"text\":\"Thế giới\"}]}"}}]}
            """.trimIndent()
        }.use { server ->
            val candidate = ComicCandidate(
                id = "page-1",
                url = "https://images.example/secret-page.jpg",
                index = 0,
                width = 1000,
                height = 1600,
                top = 0.0,
                bottom = 1600.0,
                visible = true,
                visibleHeight = 800.0,
            )
            val ocr = OnDeviceOcrPage(
                width = 1000,
                height = 1600,
                regions = listOf(
                    OverlayRegion("r1", 10.0, 20.0, 100.0, 50.0, "你好", ""),
                    OverlayRegion("r2", 20.0, 90.0, 120.0, 55.0, "世界", ""),
                ),
            )
            val result = ByoProviderClient().translatePages(
                ReaderSettings(
                    targetLanguage = "vi",
                    byoProvider = "openai-compatible",
                    byoBaseUrl = "${server.baseUrl}/v1",
                    byoModel = "local-text-model",
                    byoApiKey = "",
                ),
                listOf(candidate to ocr),
            )
            val regions = result.regionsByCandidate.getValue("page-1")
            assertEquals(listOf("Xin chào", "Thế giới"), regions.map { it.translation })
            assertEquals(listOf(10.0, 20.0), regions.map { it.x })
            assertTrue(captured.get().contains("你好"))
            assertTrue(captured.get().contains("page-1::r1"))
            assertFalse(captured.get().contains("secret-page.jpg"))
            assertFalse(captured.get().contains("\"x\""))
            assertFalse(captured.get().contains("data:image"))
        }
    }

    private data class FakeRequest(val requestLine: String, val body: String)

    private class FakeHttpServer(
        private val handler: (FakeRequest) -> String,
    ) : AutoCloseable {
        private val socket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        val baseUrl = "http://127.0.0.1:${socket.localPort}"
        private val thread = Thread {
            runCatching { serve(socket.accept()) }
        }.apply {
            isDaemon = true
            start()
        }

        private fun serve(client: Socket) {
            client.use { connection ->
                val input = connection.getInputStream()
                val headerBytes = java.io.ByteArrayOutputStream()
                var tail = 0
                while (tail != 0x0d0a0d0a) {
                    val byte = input.read()
                    if (byte < 0) break
                    headerBytes.write(byte)
                    tail = ((tail shl 8) or byte) and -1
                }
                val headersText = headerBytes.toString(Charsets.ISO_8859_1.name())
                val headerLines = headersText.split("\r\n")
                val requestLine = headerLines.firstOrNull().orEmpty()
                var contentLength = 0
                headerLines.drop(1).forEach { line ->
                    if (line.startsWith("Content-Length:", ignoreCase = true)) {
                        contentLength = line.substringAfter(':').trim().toIntOrNull() ?: 0
                    }
                }
                val body = ByteArray(contentLength)
                var offset = 0
                while (offset < body.size) {
                    val read = input.read(body, offset, body.size - offset)
                    if (read < 0) break
                    offset += read
                }
                val response = handler(
                    FakeRequest(
                        requestLine,
                        String(body, 0, offset, Charsets.UTF_8),
                    ),
                )
                    .toByteArray()
                connection.getOutputStream().use { output ->
                    val headers = (
                        "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/json\r\n" +
                            "Content-Length: ${response.size}\r\n" +
                            "Connection: close\r\n\r\n"
                        ).toByteArray()
                    output.write(headers)
                    output.write(response)
                    output.flush()
                }
            }
        }

        override fun close() {
            socket.close()
            thread.join(1_000)
        }
    }
}
