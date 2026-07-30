import UIKit
import WebKit
import SafariServices
import Security
import CryptoKit
import Foundation
#if canImport(SwiftUI)
import SwiftUI
#endif
#if canImport(Translation)
import Translation
#endif

// Comic Sub Reader deliberately keeps remote web content inside WKWebView. The
// page bridge is limited to discovered image metadata and reading anchors; it
// never receives credentials, native filesystem access, or arbitrary IPC.

private enum ProcessingRoute: String, CaseIterable, Codable {
    case automatic
    case onDevice
    case privateServer
    case managedCloud

    var title: String {
        switch self {
        case .automatic: return "Tự chọn an toàn"
        case .onDevice: return "Trên thiết bị"
        case .privateServer: return "Server riêng"
        case .managedCloud: return "Comic Sub Cloud"
        }
    }

    var privacySummary: String {
        switch self {
        case .automatic: return "Không tự chuyển sang Cloud khi chưa hỏi bạn."
        case .onDevice: return "Chỉ dịch văn bản trên thiết bị khi gói ngôn ngữ đã cài. OCR/bố cục phải có tuyến riêng."
        case .privateServer: return "Ảnh phù hợp có thể được gửi đến server bạn đã ghép nối qua HTTPS."
        case .managedCloud: return "Chỉ dùng sau khi bạn xác nhận đường truyền dữ liệu cho job này."
        }
    }
}

private struct ReaderSettings: Codable {
    var targetLanguage = "vi"
    var sourceLanguage = "zh-Hans"
    var route: ProcessingRoute = .automatic
    var endpoint = "https://comic-be.dep.app"
    var lookAhead = 2
    var privateSession = false
    var externalResearchAllowed = false
    var glossary = ""
    var historyRetentionDays = 90
}

private struct WebCandidate: Codable, Hashable {
    let id: String
    let url: String
    let index: Int
    let width: Double
    let height: Double
    let top: Double
    let intrinsicWidth: Int
    let intrinsicHeight: Int
}

private struct BrokerBatch: Decodable {
    let batchId: String
    let jobIds: [String]
    let jobs: [BrokerJob]
}

private struct BrokerJob: Decodable {
    let jobId: String
    let candidateId: String
    let state: String
}

private struct BrokerRegion: Codable {
    let id: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let rotation: Double?
    let source: String
    var translation: String
    let confidence: Double?
}

private struct BrokerAsset: Decodable {
    let contentType: String
    let byteLength: Int
    let sha256: String
    let url: String
}

private struct ModelReceipt: Decodable {
    let requestedProvider: String?
    let requestedModel: String?
    let resolvedProvider: String
    let resolvedModel: String
    let providerReportedModel: String
    let executionFingerprint: String
    let modelMatched: Bool
}

private struct BrokerResult: Decodable {
    let jobId: String
    let candidateId: String
    let page: BrokerPage
    var overlayRegions: [BrokerRegion]
    let renderedAsset: BrokerAsset
    let modelReceipt: ModelReceipt
}

private struct BrokerPage: Decodable { let width: Double; let height: Double }

private struct GlossarySnapshot: Decodable {
    let id: String
    let version: Int
    let hash: String
    let entries: [GlossarySnapshotEntry]

    static let empty = GlossarySnapshot(id: "local-empty", version: 0, hash: digest(Data()), entries: [])
}

private struct GlossarySnapshotEntry: Decodable {
    let sourceTerm: String
    let targetTerm: String
    let confidence: Double?
}

private struct SeriesBootstrapResponse: Decodable {
    let glossarySnapshot: GlossarySnapshot
}

private struct SeriesContext: Hashable {
    let id: String
    let normalizedTitle: String
    let chapterBoundary: String?
}

private struct SeriesTerm: Codable, Hashable {
    let sourceTerm: String
    let targetTerm: String
    let confidence: Double
}

private enum SeriesResearchConsent: String, Codable {
    case granted
    case declined
}

private struct AcquiredImage {
    let bytes: Data
    let mimeType: String
    let sha256: String
}

private enum BrokerError: LocalizedError {
    case invalidEndpoint
    case request(String)
    case cancelled
    case unsafeImage(String)
    case modelMismatch

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "Broker thủ công cần URL HTTPS; chỉ Mac được ghép qua Bonjour mới dùng HTTP nội bộ."
        case .request(let message): return message
        case .cancelled: return "Đã huỷ bản dịch."
        case .unsafeImage(let message): return message
        case .modelMismatch: return "Broker trả về model khác với model đã yêu cầu."
        }
    }
}

private struct DiscoveredBroker: Equatable {
    let endpoint: String
    let displayName: String

    var isLocalHTTP: Bool { URL(string: endpoint)?.scheme?.lowercased() == "http" }
}

private enum BrokerEndpointPolicy {
    static func allows(_ endpoint: String, discovered: DiscoveredBroker?) -> Bool {
        guard let url = URL(string: endpoint) else { return false }
        if url.scheme?.lowercased() == "https" { return true }
        guard url.scheme?.lowercased() == "http", discovered?.endpoint == endpoint,
              let host = url.host?.lowercased() else { return false }
        // Bonjour names are scoped to the local link. The app never accepts an
        // arbitrary manually typed HTTP address as a broker endpoint.
        return host.hasSuffix(".local") || host == "localhost" || isPrivateOrLinkLocalIPv4(host)
    }

    private static func isPrivateOrLinkLocalIPv4(_ host: String) -> Bool {
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10 ||
            (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 169 && octets[1] == 254) ||
            octets[0] == 127
    }
}

private final class BonjourBrokerDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    var onBrokerChanged: ((DiscoveredBroker?) -> Void)?
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    private var current: DiscoveredBroker?

    func start() {
        browser.delegate = self
        browser.searchForServices(ofType: "_comicsub._tcp.", inDomain: "local.")
    }

    func stop() { browser.stop(); services.forEach { $0.stop() }; services = [] }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard !services.contains(where: { $0.name == service.name && $0.domain == service.domain && $0.type == service.type }) else { return }
        services.append(service)
        service.delegate = self
        service.resolve(withTimeout: 6)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        services.removeAll { $0.name == service.name && $0.domain == service.domain && $0.type == service.type }
        if current?.displayName == service.name { current = nil; onBrokerChanged?(nil) }
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let host = sender.hostName?.trimmingCharacters(in: CharacterSet(charactersIn: ".")), sender.port > 0 else { return }
        let endpoint = "http://\(host):\(sender.port)"
        let broker = DiscoveredBroker(endpoint: endpoint, displayName: sender.name)
        guard BrokerEndpointPolicy.allows(endpoint, discovered: broker), current == nil else { return }
        current = broker
        onBrokerChanged?(broker)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) { }
}

private final class BrokerClient {
    let baseURL: URL
    let token: String
    let tenantID: String
    let deviceID: String

    init(endpoint: String, token: String, deviceID: String, discoveredBroker: DiscoveredBroker? = nil) throws {
        guard BrokerEndpointPolicy.allows(endpoint, discovered: discoveredBroker), let url = URL(string: endpoint) else { throw BrokerError.invalidEndpoint }
        baseURL = url
        self.token = token
        tenantID = "local"
        self.deviceID = deviceID
    }

    func registerSnapshot(_ payload: [String: Any]) async throws {
        _ = try await json(path: "v1/snapshots", method: "POST", payload: payload) as EmptyResponse
    }

    func createBatch(_ payload: [String: Any], idempotencyKey: String) async throws -> BrokerBatch {
        try await json(path: "v1/job-batches", method: "POST", payload: payload, extraHeaders: ["Idempotency-Key": idempotencyKey])
    }

    func bootstrapSeries(_ payload: [String: Any]) async throws -> SeriesBootstrapResponse {
        try await json(path: "v1/series/bootstrap", method: "POST", payload: payload)
    }

    func seriesGlossary(_ seriesID: String) async throws -> SeriesBootstrapResponse {
        try await json(path: "v1/series/\(encoded(seriesID))/glossary", method: "GET")
    }

    func upload(jobID: String, image: AcquiredImage) async throws {
        var request = request(path: "v1/jobs/\(encoded(jobID))/asset", method: "PUT")
        request.setValue(image.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(image.sha256, forHTTPHeaderField: "x-content-sha256")
        request.httpBody = image.bytes
        let (_, response) = try await URLSession.shared.data(for: request)
        try validate(response)
    }

    func job(_ id: String) async throws -> BrokerJob { try await json(path: "v1/jobs/\(encoded(id))", method: "GET") }
    func result(_ id: String) async throws -> BrokerResult { try await json(path: "v1/jobs/\(encoded(id))/result", method: "GET") }

    func renderedAsset(_ result: BrokerResult) async throws -> Data {
        var request = self.request(path: "v1/jobs/\(encoded(result.jobId))/rendered-asset", method: "GET")
        request.timeoutInterval = 45
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        guard data.count == result.renderedAsset.byteLength,
              digest(data) == result.renderedAsset.sha256 else {
            throw BrokerError.request("Rendered asset không khớp biên nhận broker.")
        }
        return data
    }

    func cancel(_ id: String) async {
        do { _ = try await json(path: "v1/jobs/\(encoded(id))/cancel", method: "POST") as EmptyResponse } catch { }
    }

    private func json<T: Decodable>(path: String, method: String, payload: [String: Any]? = nil, extraHeaders: [String: String] = [:]) async throws -> T {
        var request = self.request(path: path, method: method)
        for (name, value) in extraHeaders { request.setValue(value, forHTTPHeaderField: name) }
        if let payload {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, body: data)
        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func request(path: String, method: String) -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 45
        request.setValue(tenantID, forHTTPHeaderField: "x-tenant-id")
        request.setValue(deviceID, forHTTPHeaderField: "x-device-id")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func validate(_ response: URLResponse, body: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw BrokerError.request("Broker không trả HTTP response.") }
        guard (200..<300).contains(http.statusCode) else {
            let server = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])? ["error"] as? [String: Any]
            throw BrokerError.request((server?["message"] as? String) ?? "Broker trả lỗi HTTP \(http.statusCode).")
        }
    }

    private func encoded(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value }
    private struct EmptyResponse: Decodable { }
}

private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

// In-memory opaque assets are served only to the WKWebView via a private custom
// URL scheme. The page never receives the broker credential or a broker URL.
private final class ReaderAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let lock = NSLock()
    private var assets: [String: (Data, String)] = [:]

    func register(_ data: Data, mimeType: String) -> URL {
        let id = UUID().uuidString
        lock.lock(); assets[id] = (data, mimeType); lock.unlock()
        return URL(string: "comicsub://rendered/\(id)")!
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let id = urlSchemeTask.request.url?.lastPathComponent else { urlSchemeTask.didFailWithError(BrokerError.request("Thiếu rendered asset.")); return }
        lock.lock(); let asset = assets[id]; lock.unlock()
        guard let asset, let url = urlSchemeTask.request.url else { urlSchemeTask.didFailWithError(BrokerError.request("Rendered asset không còn trong phiên.")); return }
        let response = URLResponse(url: url, mimeType: asset.1, expectedContentLength: asset.0.count, textEncodingName: nil)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(asset.0)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
}

private final class BoundedImageFetcher: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    static let maximumBytes = 32 * 1024 * 1024
    private var received = Data()
    private var mimeType = ""
    private var completion: CheckedContinuation<AcquiredImage, Error>?
    private var finished = false

    @MainActor
    func fetch(candidate: WebCandidate, pageURL: URL, store: WKWebsiteDataStore) async throws -> AcquiredImage {
        guard let sourceURL = URL(string: candidate.url),
              ["http", "https"].contains(sourceURL.scheme?.lowercased() ?? "") else {
            throw BrokerError.unsafeImage("Nguồn ảnh không phải HTTP(S).")
        }
        let cookies = await cookies(for: sourceURL, store: store)
        var request = URLRequest(url: sourceURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 45
        request.httpShouldHandleCookies = false
        request.setValue(pageURL.absoluteString, forHTTPHeaderField: "Referer")
        request.setValue("image/avif,image/webp,image/apng,image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
        let cookieHeaders = HTTPCookie.requestHeaderFields(with: cookies)
        for (name, value) in cookieHeaders { request.setValue(value, forHTTPHeaderField: name) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return try await withCheckedThrowingContinuation { continuation in
            self.received = Data(); self.mimeType = ""; self.completion = continuation; self.finished = false
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            let task = session.dataTask(with: request)
            task.taskDescription = sourceURL.absoluteString
            task.resume()
        }
    }

    @MainActor
    private func cookies(for url: URL, store: WKWebsiteDataStore) async -> [HTTPCookie] {
        let all: [HTTPCookie] = await withCheckedContinuation { continuation in
            store.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        let host = url.host?.lowercased() ?? ""
        return all.filter { cookie in
            let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
            let domainMatches = host == domain || host.hasSuffix("." + domain)
            return domainMatches && (!cookie.isSecure || url.scheme?.lowercased() == "https")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // exact candidate URL only; no credential-bearing redirect chain.
        finish(.failure(BrokerError.unsafeImage("Nguồn ảnh chuyển hướng sang URL khác.")))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            completionHandler(.cancel); finish(.failure(BrokerError.unsafeImage("Nguồn ảnh không phản hồi thành công."))); return
        }
        let type = http.mimeType?.lowercased() ?? ""
        guard ["image/jpeg", "image/png", "image/webp"].contains(type) else {
            completionHandler(.cancel); finish(.failure(BrokerError.unsafeImage("Nguồn ảnh không phải JPEG, PNG hoặc WebP."))); return
        }
        if response.expectedContentLength > Int64(Self.maximumBytes) {
            completionHandler(.cancel); finish(.failure(BrokerError.unsafeImage("Ảnh vượt giới hạn 32 MiB."))); return
        }
        mimeType = type
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        guard received.count + data.count <= Self.maximumBytes else {
            dataTask.cancel(); finish(.failure(BrokerError.unsafeImage("Ảnh vượt giới hạn 32 MiB."))); return
        }
        received.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        if let error { finish(.failure(error)); return }
        guard sniffedMime(for: received) == mimeType else {
            finish(.failure(BrokerError.unsafeImage("MIME hoặc magic bytes của ảnh không hợp lệ."))); return
        }
        finish(.success(AcquiredImage(bytes: received, mimeType: mimeType, sha256: digest(received))))
    }

    private func finish(_ result: Result<AcquiredImage, Error>) {
        guard !finished else { return }
        finished = true
        let continuation = completion
        completion = nil
        switch result { case .success(let image): continuation?.resume(returning: image); case .failure(let error): continuation?.resume(throwing: error) }
    }

    private func sniffedMime(for data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff { return "image/jpeg" }
        if bytes.count >= 8 && Array(bytes.prefix(8)) == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] { return "image/png" }
        if bytes.count >= 12 && Array(bytes.prefix(4)) == [0x52, 0x49, 0x46, 0x46] && Array(bytes[8..<12]) == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
        return nil
    }
}

private struct ReadingHistoryEntry: Codable, Identifiable {
    let id: UUID
    var url: String
    var title: String
    var candidateID: String?
    var candidateIndex: Int
    var intraImageRatio: Double
    var fallbackScrollRatio: Double
    var targetLanguage: String
    var translated: Bool
    var lastOpened: Date

    static func sanitizedURL(_ value: URL) -> String {
        var components = URLComponents(url: value, resolvingAgainstBaseURL: false)
        components?.query = nil
        components?.fragment = nil
        return components?.url?.absoluteString ?? value.absoluteString
    }
}

private final class ReaderSettingsStore {
    static let shared = ReaderSettingsStore()
    private let settingsKey = "ComicSubReaderSettings.v1"
    private let tokenKey = "com.tienle.comicsub.reader.auth-token"

    func load() -> ReaderSettings {
        guard let data = UserDefaults.standard.data(forKey: settingsKey),
              let settings = try? JSONDecoder().decode(ReaderSettings.self, from: data) else {
            return ReaderSettings()
        }
        // Migration from builds that required a manually typed broker URL.
        if settings.endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var migrated = settings
            migrated.endpoint = ReaderSettings().endpoint
            save(migrated)
            return migrated
        }
        return settings
    }

    func save(_ settings: ReaderSettings) {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        UserDefaults.standard.set(data, forKey: settingsKey)
    }

    func loadToken() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    func saveToken(_ token: String) {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenKey,
        ]
        SecItemDelete(query as CFDictionary)
        guard !token.isEmpty else { return }
        SecItemAdd((query.merging([kSecValueData as String: data]) { _, new in new }) as CFDictionary, nil)
    }
}

// Consent is deliberately scoped to a stable series fingerprint, not a URL or
// chapter. Private sessions never read or write this store.
private final class SeriesConsentStore {
    static let shared = SeriesConsentStore()
    private let key = "ComicSubSeriesResearchConsent.v1"

    func consent(for seriesID: String) -> SeriesResearchConsent? {
        guard let raw = UserDefaults.standard.dictionary(forKey: key)?[seriesID] as? String else { return nil }
        return SeriesResearchConsent(rawValue: raw)
    }

    func save(_ consent: SeriesResearchConsent, for seriesID: String) {
        var values = UserDefaults.standard.dictionary(forKey: key) ?? [:]
        values[seriesID] = consent.rawValue
        UserDefaults.standard.set(values, forKey: key)
    }
}

private final class SeriesContinuityStore {
    static let shared = SeriesContinuityStore()
    private let key = "ComicSubSeriesContinuity.v1"

    func terms(for seriesID: String) -> [SeriesTerm] {
        guard let values = UserDefaults.standard.dictionary(forKey: key)?[seriesID] as? Data,
              let terms = try? JSONDecoder().decode([SeriesTerm].self, from: values) else { return [] }
        return terms
    }

    func save(_ terms: [SeriesTerm], for seriesID: String) {
        guard let data = try? JSONEncoder().encode(terms) else { return }
        var values = UserDefaults.standard.dictionary(forKey: key) ?? [:]
        values[seriesID] = data
        UserDefaults.standard.set(values, forKey: key)
    }
}

private final class ReadingHistoryStore {
    private let filename = "comic-sub-reading-history.json"
    private var url: URL? {
        let manager = FileManager.default
        guard let directory = try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return directory.appendingPathComponent(filename)
    }

    func load() -> [ReadingHistoryEntry] {
        guard let url, let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([ReadingHistoryEntry].self, from: data) else { return [] }
        return entries.sorted { $0.lastOpened > $1.lastOpened }
    }

    func upsert(_ entry: ReadingHistoryEntry, retentionDays: Int) {
        var entries = load().filter { $0.url != entry.url }
        entries.insert(entry, at: 0)
        let cutoff = Calendar.current.date(byAdding: .day, value: -max(retentionDays, 1), to: Date()) ?? .distantPast
        write(entries.filter { $0.lastOpened >= cutoff })
    }

    func delete(_ entry: ReadingHistoryEntry) { write(load().filter { $0.id != entry.id }) }
    func clear() { write([]) }

    private func write(_ entries: [ReadingHistoryEntry]) {
        guard let url, let data = try? JSONEncoder().encode(entries) else { return }
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            // History is convenience data. Never surface an opaque write failure over reading.
        }
    }
}

private enum OnDeviceTranslationState: Equatable {
    case unavailable(String)
    case installed
    case downloadable
    case unsupported

    var message: String {
        switch self {
        case .unavailable(let detail): return detail
        case .installed: return "Dịch văn bản trên thiết bị đã sẵn sàng."
        case .downloadable: return "Cặp ngôn ngữ được hỗ trợ nhưng chưa cài trên thiết bị."
        case .unsupported: return "Apple không hỗ trợ cặp ngôn ngữ này trên thiết bị này."
        }
    }
}

private final class OnDeviceTranslationCapability {
    func check(source: String, target: String) async -> OnDeviceTranslationState {
        #if canImport(Translation)
        guard #available(iOS 18.0, *) else {
            return .unavailable("Dịch văn bản trên thiết bị cần iOS 18 trở lên.")
        }
        let sourceLanguage = Locale.Language(identifier: source)
        let targetLanguage = Locale.Language(identifier: target)
        let availability = LanguageAvailability()
        let status = await availability.status(from: sourceLanguage, to: targetLanguage)
        switch status {
        case .installed: return .installed
        case .supported: return .downloadable
        case .unsupported: return .unsupported
        @unknown default: return .unsupported
        }
        #else
        return .unavailable("Translation framework không có trong SDK đang dùng.")
        #endif
    }

    // This is intentionally text-only. Candidate images need a local OCR/layout
    // adapter before the app may claim a fully-local comic pipeline.
    func translateInstalledText(_ text: String, source: String, target: String) async throws -> String {
        #if canImport(Translation)
        // Apple only exposes the direct installed-session initializer from iOS
        // 26. On iOS 18–25 we still report language availability truthfully;
        // invoking a system download/translation sheet belongs to a SwiftUI
        // translationTask host, which is intentionally not faked here.
        guard #available(iOS 26.0, *) else { throw NSError(domain: "ComicSub", code: 26, userInfo: [NSLocalizedDescriptionKey: "Thiết bị này có thể báo trạng thái gói ngôn ngữ, nhưng API dịch trực tiếp cần iOS 26 trở lên."]) }
        let session = TranslationSession(
            installedSource: Locale.Language(identifier: source),
            target: Locale.Language(identifier: target)
        )
        return try await session.translate(text).targetText
        #else
        throw NSError(domain: "ComicSub", code: 0, userInfo: [NSLocalizedDescriptionKey: "Translation framework không có trong SDK này."])
        #endif
    }
}

#if canImport(Translation) && canImport(SwiftUI)
@available(iOS 18.0, *)
private struct TranslationPreparationView: View {
    @State private var configuration: TranslationSession.Configuration?
    @State private var status = "Đang yêu cầu gói ngôn ngữ từ Apple…"
    let completion: (Bool) -> Void

    init(source: String, target: String, completion: @escaping (Bool) -> Void) {
        _configuration = State(initialValue: TranslationSession.Configuration(
            source: Locale.Language(identifier: source),
            target: Locale.Language(identifier: target)
        ))
        self.completion = completion
    }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 36))
            Text("Chuẩn bị dịch trên thiết bị")
                .font(.headline)
            Text(status)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .translationTask(configuration) { session in
            do {
                try await session.prepareTranslation()
                await MainActor.run {
                    status = "Gói ngôn ngữ đã sẵn sàng."
                    completion(true)
                }
            } catch {
                await MainActor.run {
                    status = "Không thể tải gói ngôn ngữ: \(error.localizedDescription)"
                    completion(false)
                }
            }
        }
    }
}

@available(iOS 18.0, *)
private struct ClientRegionTranslationView: View {
    @State private var configuration: TranslationSession.Configuration?
    let source: String
    let target: String
    let texts: [String]
    let completion: (Result<[String], Error>) -> Void

    init(source: String, target: String, texts: [String], completion: @escaping (Result<[String], Error>) -> Void) {
        _configuration = State(initialValue: TranslationSession.Configuration(
            source: Locale.Language(identifier: source), target: Locale.Language(identifier: target)
        ))
        self.source = source; self.target = target; self.texts = texts; self.completion = completion
    }

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Đang dịch văn bản trên thiết bị")
            Text("Ảnh truyện không rời khỏi tuyến OCR đã chọn.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(28)
        .translationTask(configuration) { session in
            do {
                let requests = texts.enumerated().map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
                let responses = try await session.translations(from: requests)
                let ordered = responses.sorted { (Int($0.clientIdentifier ?? "0") ?? 0) < (Int($1.clientIdentifier ?? "0") ?? 0) }.map(\.targetText)
                await MainActor.run { completion(.success(ordered)) }
            } catch {
                await MainActor.run { completion(.failure(error)) }
            }
        }
    }
}
#endif

private enum ReaderBridge {
    static let script = #"""
    (() => {
      if (window.__comicSubReaderBridge) return;
      const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.comicSubBridge;
      if (!handler) return;
      const candidateURL = image => image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-lazy-src') || '';
      const visible = image => {
        const style = getComputedStyle(image);
        const rect = image.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 240 && rect.height >= 180;
      };
      const idFor = image => image.__comicSubCandidateId || (image.__comicSubCandidateId = `candidate-${[...document.images].indexOf(image)}`);
      const scan = () => {
        const found = [...document.images].map((image, index) => ({ image, index })).filter(({ image }) => visible(image)).map(({ image, index }) => {
          const rect = image.getBoundingClientRect();
          const url = candidateURL(image);
          return { id: idFor(image), url, index, width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top + scrollY), intrinsicWidth: image.naturalWidth || Math.round(rect.width), intrinsicHeight: image.naturalHeight || Math.round(rect.height) };
        }).filter(item => /^https?:/i.test(item.url)).slice(0, 200);
        handler.postMessage({ type: 'candidates', url: location.href, title: document.title || location.hostname, candidates: found });
      };
      let timer;
      const announceAnchor = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const images = [...document.images].filter(visible);
          const current = images.find(image => image.getBoundingClientRect().bottom > innerHeight * .25) || images[0];
          if (!current) return;
          const rect = current.getBoundingClientRect();
          const index = [...document.images].indexOf(current);
          handler.postMessage({ type: 'anchor', id: idFor(current), index, ratio: Math.max(0, Math.min(1, (innerHeight * .25 - rect.top) / Math.max(rect.height, 1))), scrollRatio: scrollY / Math.max(document.documentElement.scrollHeight - innerHeight, 1) });
        }, 280);
      };
      const imageFor = id => [...document.images].find(item => idFor(item) === id);
      const layers = new Map();
      const ensureLayer = id => {
        if (layers.has(id)) return layers.get(id);
        const layer = document.createElement('div');
        layer.dataset.comicSubLayer = id; layer.style.cssText = 'position:absolute;z-index:2147483000;pointer-events:none;overflow:hidden;';
        document.body.append(layer); layers.set(id, layer); return layer;
      };
      const layout = id => {
        const image = imageFor(id), layer = layers.get(id); if (!image || !layer) return null;
        const rect = image.getBoundingClientRect();
        Object.assign(layer.style, { left: `${rect.left + scrollX}px`, top: `${rect.top + scrollY}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        return { image, layer, rect };
      };
      const place = (node, region, page, rect) => Object.assign(node.style, { position: 'absolute', left: `${region.x / page.width * rect.width}px`, top: `${region.y / page.height * rect.height}px`, width: `${region.width / page.width * rect.width}px`, height: `${region.height / page.height * rect.height}px`, transform: `rotate(${region.rotation || 0}deg)` });
      const applyRendered = (id, assetURL, label) => {
        const target = layout(id); if (!target) return false;
        target.layer.replaceChildren();
        const image = document.createElement('img'); image.src = assetURL; image.alt = label; image.setAttribute('role', 'img'); image.style.cssText = 'width:100%;height:100%;display:block;'; target.layer.append(image); return true;
      };
      const applyRegions = (id, regions, page, semanticOnly) => {
        const target = layout(id); if (!target) return false;
        if (!semanticOnly) target.layer.replaceChildren();
        regions.forEach(region => { const node = document.createElement('div'); node.textContent = region.translation; node.setAttribute('role', 'note'); node.setAttribute('aria-label', `Bản dịch: ${region.translation}`); place(node, region, page, target.rect); node.style.cssText += semanticOnly ? ';opacity:0;' : ';display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:3px;background:rgba(255,253,245,.94);color:#17130e;border-radius:4px;text-align:center;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;line-height:1.15;overflow:hidden;'; target.layer.append(node); }); return true;
      };
      const relayout = () => layers.forEach((_, id) => layout(id));
      window.__comicSubReaderBridge = { scan, scrollToCandidate: id => { const image = imageFor(id); if (image) image.scrollIntoView({ block: 'start', behavior: 'auto' }); return !!image; }, applyRendered, applyRegions, relayout, clear: id => { layers.get(id)?.remove(); layers.delete(id); } };
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'data-original', 'data-lazy-src'] });
      addEventListener('load', scan, true);
      addEventListener('scroll', announceAnchor, { passive: true });
      addEventListener('resize', relayout, { passive: true });
      setTimeout(scan, 350);
      setTimeout(scan, 1500);
    })();
    """#
}

@MainActor
class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, UITextFieldDelegate {
    @IBOutlet var webView: WKWebView!

    private let settingsStore = ReaderSettingsStore.shared
    private let historyStore = ReadingHistoryStore()
    private let seriesConsentStore = SeriesConsentStore.shared
    private let seriesContinuityStore = SeriesContinuityStore.shared
    private let translationCapability = OnDeviceTranslationCapability()
    private let assetHandler = ReaderAssetSchemeHandler()
    private let brokerDiscovery = BonjourBrokerDiscovery()
    private var settings = ReaderSettingsStore.shared.load()
    private var candidates: [WebCandidate] = []
    private var pageTitle = ""
    private var discoveredBroker: DiscoveredBroker?
    private var glossarySnapshots: [String: GlossarySnapshot] = [:]
    private var inMemoryContinuity: [String: [SeriesTerm]] = [:]
    private var privateSeriesConsents: [String: SeriesResearchConsent] = [:]
    private var consentPromptInFlight = Set<String>()
    private var currentAnchor: (id: String?, index: Int, ratio: Double, scrollRatio: Double) = (nil, 0, 0, 0)
    private var resumeURL: String?
    private var saveTimer: Timer?
    private var isTranslatedSession = false
    private var navigationID = "navigation-\(UUID().uuidString)"
    private var activeJobIDs = Set<String>()
    private var activeBroker: BrokerClient?
    private var translationTask: Task<Void, Never>?
    private weak var translationHost: UIViewController?
    private var deviceID: String {
        let key = "ComicSubReaderDeviceID.v1"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let generated = "ios-\(UUID().uuidString)"
        UserDefaults.standard.set(generated, forKey: key)
        return generated
    }

    private let chrome = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
    private let addressField = UITextField()
    private let backButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private let reloadButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private let settingsButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let translateButton = UIButton(type: .system)
    private let homeCard = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Comic Sub"
        configureWebView(privateSession: settings.privateSession, preserving: nil)
        configureChrome()
        configureHomeCard()
        configureTranslationButton()
        brokerDiscovery.onBrokerChanged = { [weak self] broker in
            guard let self else { return }
            self.discoveredBroker = broker
            if let broker {
                self.updateRouteStatus("Đã ghép Mac: \(broker.displayName) · broker nội bộ")
            }
        }
        brokerDiscovery.start()
        updateRouteStatus("Dán link truyện để bắt đầu đọc.")
    }

    deinit { saveTimer?.invalidate() }

    private func configuredWebView(privateSession: Bool) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = privateSession ? .nonPersistent() : .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(assetHandler, forURLScheme: "comicsub")
        configuration.userContentController.addUserScript(WKUserScript(source: ReaderBridge.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        configuration.userContentController.add(self, name: "comicSubBridge")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        view.navigationDelegate = self
        view.scrollView.keyboardDismissMode = .interactive
        view.translatesAutoresizingMaskIntoConstraints = false
        view.accessibilityLabel = "Trang truyện"
        return view
    }

    private func configureWebView(privateSession: Bool, preserving url: URL?) {
        let oldWebView = webView
        let newWebView = configuredWebView(privateSession: privateSession)
        webView = newWebView
        oldWebView?.removeFromSuperview()
        view.insertSubview(newWebView, at: 0)
        NSLayoutConstraint.activate([
            newWebView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            newWebView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            newWebView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 52),
            newWebView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        if let url { newWebView.load(URLRequest(url: url)) }
    }

    private func configureChrome() {
        chrome.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(chrome)
        NSLayoutConstraint.activate([
            chrome.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            chrome.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            chrome.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            chrome.heightAnchor.constraint(equalToConstant: 52),
        ])

        [backButton, forwardButton, reloadButton, shareButton, settingsButton].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            $0.tintColor = .label
            $0.widthAnchor.constraint(equalToConstant: 36).isActive = true
            $0.heightAnchor.constraint(equalToConstant: 44).isActive = true
            chrome.contentView.addSubview($0)
        }
        backButton.setImage(UIImage(systemName: "chevron.backward"), for: .normal)
        forwardButton.setImage(UIImage(systemName: "chevron.forward"), for: .normal)
        reloadButton.setImage(UIImage(systemName: "arrow.clockwise"), for: .normal)
        shareButton.setImage(UIImage(systemName: "square.and.arrow.up"), for: .normal)
        settingsButton.setImage(UIImage(systemName: "slider.horizontal.3"), for: .normal)
        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        forwardButton.addTarget(self, action: #selector(goForward), for: .touchUpInside)
        reloadButton.addTarget(self, action: #selector(reloadPage), for: .touchUpInside)
        shareButton.addTarget(self, action: #selector(sharePage), for: .touchUpInside)
        settingsButton.addTarget(self, action: #selector(showSettings), for: .touchUpInside)

        addressField.translatesAutoresizingMaskIntoConstraints = false
        addressField.delegate = self
        addressField.returnKeyType = .go
        addressField.autocapitalizationType = .none
        addressField.autocorrectionType = .no
        addressField.keyboardType = .URL
        addressField.placeholder = "Dán link chapter"
        addressField.font = .preferredFont(forTextStyle: .subheadline)
        addressField.backgroundColor = UIColor.secondarySystemFill
        addressField.layer.cornerRadius = 10
        addressField.leftView = UIImageView(image: UIImage(systemName: "lock"))
        addressField.leftView?.tintColor = .secondaryLabel
        addressField.leftView?.contentMode = .center
        addressField.leftView?.frame.size = CGSize(width: 30, height: 30)
        addressField.leftViewMode = .always
        addressField.accessibilityLabel = "Địa chỉ trang truyện"
        chrome.contentView.addSubview(addressField)
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: chrome.contentView.leadingAnchor, constant: 4),
            backButton.centerYAnchor.constraint(equalTo: chrome.contentView.centerYAnchor),
            forwardButton.leadingAnchor.constraint(equalTo: backButton.trailingAnchor),
            forwardButton.centerYAnchor.constraint(equalTo: chrome.contentView.centerYAnchor),
            reloadButton.leadingAnchor.constraint(equalTo: forwardButton.trailingAnchor),
            reloadButton.centerYAnchor.constraint(equalTo: chrome.contentView.centerYAnchor),
            settingsButton.trailingAnchor.constraint(equalTo: chrome.contentView.trailingAnchor, constant: -4),
            settingsButton.centerYAnchor.constraint(equalTo: chrome.contentView.centerYAnchor),
            shareButton.trailingAnchor.constraint(equalTo: settingsButton.leadingAnchor),
            shareButton.centerYAnchor.constraint(equalTo: chrome.contentView.centerYAnchor),
            addressField.leadingAnchor.constraint(equalTo: reloadButton.trailingAnchor, constant: 4),
            addressField.trailingAnchor.constraint(equalTo: shareButton.leadingAnchor, constant: -4),
            addressField.centerYAnchor.constraint(equalTo: chrome.contentView.centerYAnchor),
            addressField.heightAnchor.constraint(equalToConstant: 36),
        ])

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.numberOfLines = 2
        statusLabel.textColor = .secondaryLabel
        statusLabel.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.92)
        statusLabel.layer.cornerRadius = 9
        statusLabel.layer.masksToBounds = true
        statusLabel.textAlignment = .center
        statusLabel.isAccessibilityElement = true
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -82),
            statusLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
        ])
    }

    private func configureTranslationButton() {
        translateButton.translatesAutoresizingMaskIntoConstraints = false
        translateButton.configuration = .filled()
        translateButton.configuration?.title = "Dịch phần đang đọc"
        translateButton.configuration?.image = UIImage(systemName: "sparkles")
        translateButton.configuration?.imagePadding = 7
        translateButton.configuration?.cornerStyle = .capsule
        translateButton.addTarget(self, action: #selector(showTranslateMenu), for: .touchUpInside)
        translateButton.accessibilityHint = "Chọn dịch phần đang xem hoặc toàn bộ ảnh đã tải"
        view.addSubview(translateButton)
        NSLayoutConstraint.activate([
            translateButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            translateButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -18),
            translateButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 46),
        ])
    }

    private func configureHomeCard() {
        homeCard.translatesAutoresizingMaskIntoConstraints = false
        homeCard.layer.cornerRadius = 18
        homeCard.layer.masksToBounds = true
        view.addSubview(homeCard)
        let title = UILabel()
        title.text = "Đọc truyện, dịch đúng chỗ"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        let detail = UILabel()
        detail.text = "Dán URL chapter. Comic Sub chỉ lưu vị trí đọc khi bạn không dùng Phiên riêng tư."
        detail.numberOfLines = 0
        detail.font = .preferredFont(forTextStyle: .body)
        let paste = UIButton(type: .system)
        paste.configuration = .filled()
        paste.configuration?.title = "Dán link truyện"
        paste.addTarget(self, action: #selector(pasteAndOpen), for: .touchUpInside)
        let history = UIButton(type: .system)
        history.configuration = .bordered()
        history.configuration?.title = "Đọc tiếp"
        history.addTarget(self, action: #selector(showHistory), for: .touchUpInside)
        let privateButton = UIButton(type: .system)
        privateButton.configuration = .plain()
        privateButton.configuration?.title = "Bắt đầu Phiên riêng tư"
        privateButton.addTarget(self, action: #selector(startPrivateSession), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, detail, paste, history, privateButton])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 12
        homeCard.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            homeCard.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            homeCard.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            homeCard.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: homeCard.contentView.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: homeCard.contentView.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: homeCard.contentView.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: homeCard.contentView.bottomAnchor, constant: -20),
        ])
    }

    @objc private func pasteAndOpen() {
        addressField.text = UIPasteboard.general.string
        loadAddress()
    }

    @objc private func startPrivateSession() {
        guard !settings.privateSession else { return }
        settings.privateSession = true
        settingsStore.save(settings)
        let url = webView.url
        configureWebView(privateSession: true, preserving: url)
        homeCard.isHidden = false
        updateRouteStatus("Phiên riêng tư: không lưu lịch sử, cookie hoặc cache đọc.")
    }

    @objc private func goBack() { webView.goBack() }
    @objc private func goForward() { webView.goForward() }
    @objc private func reloadPage() { webView.reload() }

    @objc private func sharePage() {
        guard let url = webView.url else { return }
        present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: true)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        loadAddress()
        return true
    }

    private func loadAddress() {
        guard let input = addressField.text?.trimmingCharacters(in: .whitespacesAndNewlines), !input.isEmpty else { return }
        let urlString = input.contains("://") ? input : "https://\(input)"
        guard let url = URL(string: urlString), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            showAlert(title: "Link chưa hợp lệ", message: "Dùng URL http:// hoặc https:// của một chapter.")
            return
        }
        homeCard.isHidden = true
        candidates = []
        currentAnchor = (nil, 0, 0, 0)
        resumeURL = nil
        isTranslatedSession = false
        updateRouteStatus("Đang mở trang an toàn…")
        webView.load(URLRequest(url: url))
    }

    @objc private func showTranslateMenu() {
        guard !candidates.isEmpty else {
            showAlert(title: "Chưa thấy ảnh truyện", message: "Comic Sub đang tìm ảnh lớn trong trang. Ảnh canvas, DRM hoặc reader chặn truy cập sẽ không được lấy tự động.")
            return
        }
        let sheet = UIAlertController(title: "Dịch truyện", message: "\(candidates.count) ảnh đang tải trong trang này. Ảnh xuất hiện sau sẽ chờ một đợt mới và không tự tính phí.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Dịch phần đang đọc", style: .default) { _ in self.beginTranslation(scope: .visible) })
        sheet.addAction(UIAlertAction(title: "Dịch toàn bộ ảnh hiện có", style: .default) { _ in self.showAllPreflight() })
        sheet.addAction(UIAlertAction(title: "Hiện ảnh gốc", style: .default) { _ in self.updateRouteStatus("Ảnh gốc luôn được giữ nguyên trong WebView.") })
        if !activeJobIDs.isEmpty {
            sheet.addAction(UIAlertAction(title: "Huỷ job đang chạy", style: .destructive) { _ in self.cancelActiveTranslation() })
        }
        sheet.addAction(UIAlertAction(title: "Huỷ", style: .cancel))
        if let popover = sheet.popoverPresentationController { popover.sourceView = translateButton; popover.sourceRect = translateButton.bounds }
        present(sheet, animated: true)
    }

    private func showAllPreflight() {
        let estimate = max(1, candidates.count / 5)
        let route = currentRouteLabel()
        let message = "Dịch \(candidates.count) ảnh đang tải trong trang này. Ước tính \(estimate)–\(estimate * 2) phút · \(route). Ảnh mới sẽ không tự vào job này."
        let alert = UIAlertController(title: "Xác nhận dịch toàn bộ", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Dịch \(candidates.count) ảnh", style: .default) { _ in self.beginTranslation(scope: .all) })
        alert.addAction(UIAlertAction(title: "Huỷ", style: .cancel))
        present(alert, animated: true)
    }

    private enum TranslationScope { case visible, all }

    private func beginTranslation(scope: TranslationScope) {
        let selected: [WebCandidate]
        switch scope {
        case .visible:
            selected = candidates.filter { $0.index >= currentAnchor.index }.prefix(max(1, settings.lookAhead + 1)).map { $0 }
        case .all: selected = candidates
        }
        guard !selected.isEmpty else { return }
        cancelActiveTranslation(silent: true)
        isTranslatedSession = true
        let navigation = navigationID
        updateRouteStatus("Đang đăng ký \(selected.count) ảnh · \(currentRouteLabel())")
        translationTask = Task { [weak self] in
            guard let self else { return }
            await self.translate(selected, navigationID: navigation)
        }
    }

    private func translate(_ selected: [WebCandidate], navigationID expectedNavigationID: String) async {
        do {
            guard let pageURL = webView.url, pageURL.scheme?.hasPrefix("http") == true else { throw BrokerError.request("Trang truyện chưa có URL hợp lệ.") }
            let client = try BrokerClient(endpoint: brokerEndpoint, token: settingsStore.loadToken(), deviceID: deviceID, discoveredBroker: discoveredBroker)
            activeBroker = client
            let isClientDevice = try await routeContract()
            let series = seriesContext(for: pageURL)
            let glossary = try await latestSeriesGlossary(client: client, series: series)
            updateRouteStatus(isClientDevice
                ? "OCR/bố cục sẽ dùng broker; chỉ dịch văn bản chạy trên thiết bị."
                : (settings.route == .managedCloud
                    ? "Ảnh đã chọn sẽ gửi tới Managed Cloud sau khi batch được đăng ký."
                    : "Ảnh đã chọn sẽ gửi tới broker/server riêng sau khi batch được đăng ký."))
            try Task.checkCancellation()
            let snapshotID = "snapshot-\(UUID().uuidString)"
            let snapshot = makeSnapshot(snapshotID: snapshotID, candidates: selected, pageURL: pageURL)
            try await client.registerSnapshot(snapshot)
            try Task.checkCancellation()
            let request = makeBatchRequest(snapshotID: snapshotID, candidates: selected, clientDevice: isClientDevice, glossary: glossary)
            let batch = try await client.createBatch(request, idempotencyKey: "ios-\(UUID().uuidString)")
            activeJobIDs = Set(batch.jobIds)
            guard batch.jobs.count == selected.count else { throw BrokerError.request("Broker trả batch không đầy đủ.") }
            for (offset, job) in batch.jobs.enumerated() {
                try Task.checkCancellation()
                guard navigationID == expectedNavigationID else { throw BrokerError.cancelled }
                let candidate = selected[offset]
                guard job.candidateId == candidate.id else { throw BrokerError.request("Broker ghép sai ảnh trong snapshot.") }
                updateRouteStatus("Đang lấy ảnh \(offset + 1)/\(selected.count) một cách an toàn…")
                let image = try await BoundedImageFetcher().fetch(candidate: candidate, pageURL: pageURL, store: webView.configuration.websiteDataStore)
                try Task.checkCancellation()
                updateRouteStatus("Đã xác minh SHA-256 · đang dịch ảnh \(offset + 1)/\(selected.count)…")
                try await client.upload(jobID: job.jobId, image: image)
                let settled = try await pollSettled(client: client, jobID: job.jobId)
                guard settled.state == "SETTLED" else { throw BrokerError.request("Job kết thúc ở trạng thái \(settled.state).") }
                var result = try await client.result(job.jobId)
                try verifyReceipt(result.modelReceipt, clientDevice: isClientDevice)
                if isClientDevice {
                    let source = result.overlayRegions.map(\.source)
                    let translated = try await translateOnDevice(source)
                    guard translated.count == result.overlayRegions.count else { throw BrokerError.request("Apple Translation trả thiếu vùng văn bản.") }
                    for index in result.overlayRegions.indices { result.overlayRegions[index].translation = translated[index] }
                    attachRegions(result, to: candidate)
                } else {
                    let asset = try await client.renderedAsset(result)
                    attachRendered(asset, mimeType: result.renderedAsset.contentType, result: result, to: candidate)
                }
                recordSuccessfulTranslation(result, series: series, client: client)
                activeJobIDs.remove(job.jobId)
                updateRouteStatus("Đã dịch \(offset + 1)/\(selected.count) · \(result.modelReceipt.resolvedProvider)/\(result.modelReceipt.resolvedModel)")
            }
            saveCurrentProgress(force: true)
        } catch is CancellationError {
            updateRouteStatus("Đã huỷ bản dịch. Ảnh gốc vẫn hiển thị.")
        } catch let error as BrokerError {
            if case .cancelled = error {
                updateRouteStatus("Đã huỷ bản dịch. Ảnh gốc vẫn hiển thị.")
            } else {
                updateRouteStatus("Không dịch được. Ảnh gốc vẫn hiển thị.")
                showAlert(title: "Bản dịch chưa hoàn tất", message: error.localizedDescription)
            }
        } catch {
            updateRouteStatus("Không dịch được. Ảnh gốc vẫn hiển thị.")
            showAlert(title: "Bản dịch chưa hoàn tất", message: error.localizedDescription)
        }
        activeJobIDs.removeAll(); activeBroker = nil; translationTask = nil
    }

    private func routeContract() async throws -> Bool {
        switch settings.route {
        case .onDevice, .automatic:
            let state = await translationCapability.check(source: settings.sourceLanguage, target: settings.targetLanguage)
            guard state == .installed else {
                if state == .downloadable { presentLanguageDownload() }
                throw BrokerError.request(state.message)
            }
            return true
        case .privateServer, .managedCloud:
            guard BrokerEndpointPolicy.allows(brokerEndpoint, discovered: discoveredBroker) else { throw BrokerError.invalidEndpoint }
            return false
        }
    }

    private func makeSnapshot(snapshotID: String, candidates: [WebCandidate], pageURL: URL) -> [String: Any] {
        let pageOrigin = origin(for: pageURL)
        return [
            "snapshotId": snapshotID,
            "navigationId": navigationID,
            "topFrameOrigin": pageOrigin,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "candidates": candidates.compactMap { candidate -> [String: Any]? in
                guard let source = URL(string: candidate.url) else { return nil }
                return ["candidateId": candidate.id, "frameId": "top", "domOrdinal": candidate.index,
                        "sourceUrl": candidate.url, "sourceOrigin": origin(for: source),
                        "renderedRect": ["x": 0, "y": candidate.top, "width": candidate.width, "height": candidate.height],
                        "intrinsicWidth": candidate.intrinsicWidth, "intrinsicHeight": candidate.intrinsicHeight,
                        "acquisitionCapabilities": ["source-blob"]]
            },
        ]
    }

    private func makeBatchRequest(snapshotID: String, candidates: [WebCandidate], clientDevice: Bool, glossary: GlossarySnapshot) -> [String: Any] {
        let request: [String: Any]
        if clientDevice {
            request = ["locus": "on-device", "profile": "balanced", "provider": "apple", "model": "apple-translation", "allowedFallbacks": []]
        } else {
            let locus = settings.route == .managedCloud ? "managed" : "private-server"
            request = ["locus": locus, "profile": "balanced", "provider": "gemini", "model": "gemini-3.6-flash", "allowedFallbacks": []]
        }
        return [
            "snapshotId": snapshotID, "candidateIds": candidates.map(\.id), "requestedExecution": request,
            "pipeline": ["translationMode": clientDevice ? "client-device" : "server", "ocrVersion": "paddle-ocr-vl-1.6", "layoutVersion": "comic-text-bubble-detector", "renderVersion": "source-overlay-v1", "promptVersion": "zh-comic-vi-v1"],
            "language": ["source": settings.sourceLanguage, "target": settings.targetLanguage],
            "translationStyle": "natural-dialogue",
            "glossarySnapshot": ["id": glossary.id, "version": glossary.version, "hash": glossary.hash],
            "privacyPolicyVersion": settings.privateSession ? "private-v1" : "reader-v1",
            "budget": ["currency": "USD", "maxMicros": settings.route == .managedCloud ? 500_000 : 0],
        ]
    }

    // The series key is intentionally derived on-device from host + a cleaned
    // page title. URLs, chapter images and raw OCR never become research input.
    private func seriesContext(for pageURL: URL) -> SeriesContext {
        let rawTitle = pageTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let splitTitle = rawTitle.split(separator: "|", maxSplits: 1).first.map(String.init) ?? rawTitle
        let titleWithoutChapter = splitTitle.replacingOccurrences(
            of: "(?i)\\b(chapter|chap|chương|chuong|ch\\.)\\s*[0-9]+.*$",
            with: "",
            options: .regularExpression
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTitle = (titleWithoutChapter.isEmpty ? (pageURL.host ?? "Truyện chưa đặt tên") : titleWithoutChapter)
            .folding(options: [.diacriticInsensitive, .widthInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let stableInput = "\(pageURL.host?.lowercased() ?? "local")\u{0}\(normalizedTitle.lowercased())"
        let id = "series-\(digest(Data(stableInput.utf8)).prefix(48))"
        let chapter = rawTitle.isEmpty ? nil : String(rawTitle.prefix(128))
        return SeriesContext(id: id, normalizedTitle: String(normalizedTitle.prefix(256)), chapterBoundary: chapter)
    }

    private func consent(for series: SeriesContext) -> SeriesResearchConsent? {
        settings.privateSession ? privateSeriesConsents[series.id] : seriesConsentStore.consent(for: series.id)
    }

    private func latestSeriesGlossary(client: BrokerClient, series: SeriesContext) async throws -> GlossarySnapshot {
        // The first page remains fast and independent. Following a successful
        // page, consent/local continuity has been recorded and every later job
        // bootstraps then fetches the broker's current immutable snapshot.
        guard let consent = consent(for: series) else { return glossarySnapshots[series.id] ?? .empty }
        let bootstrap = try await client.bootstrapSeries(seriesBootstrapPayload(series, consent: consent))
        let latest = (try? await client.seriesGlossary(series.id)) ?? bootstrap
        glossarySnapshots[series.id] = latest.glossarySnapshot
        mergeContinuity(latest.glossarySnapshot.entries.map {
            SeriesTerm(sourceTerm: $0.sourceTerm, targetTerm: $0.targetTerm, confidence: $0.confidence ?? 0.8)
        }, into: series)
        return latest.glossarySnapshot
    }

    private func seriesBootstrapPayload(_ series: SeriesContext, consent: SeriesResearchConsent) -> [String: Any] {
        let continuity = inMemoryContinuity[series.id] ?? (settings.privateSession ? [] : seriesContinuityStore.terms(for: series.id))
        let aliases = Array(Set(([series.normalizedTitle] + continuity.map(\.sourceTerm))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.count <= 256 })).sorted().prefix(1_000)
        var researchConsent: [String: Any] = [
            "seriesId": series.id,
            "policyVersion": "series-research-v1",
            "state": consent.rawValue,
            "allowedSourceClasses": ["wikidata", "mediawiki", "anilist"],
        ]
        if consent == .granted { researchConsent["grantedAt"] = ISO8601DateFormatter().string(from: Date()) }
        return [
            "seriesId": series.id,
            "title": series.normalizedTitle,
            "seriesStatus": "confirmed",
            "chapterBoundary": series.chapterBoundary ?? NSNull(),
            "targetLanguage": settings.targetLanguage,
            "privateMode": settings.privateSession,
            "localContinuity": continuity.map { ["sourceTerm": $0.sourceTerm, "targetTerm": $0.targetTerm, "confidence": $0.confidence] },
            "userCorrections": manualGlossaryCorrections(),
            "locallyObservedAliases": Array(aliases),
            "researchConsent": researchConsent,
        ]
    }

    private func manualGlossaryCorrections() -> [[String: Any]] {
        settings.glossary.split(whereSeparator: \.isNewline).compactMap { line in
            let pair = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            guard pair.count == 2, !pair[0].isEmpty, !pair[1].isEmpty else { return nil }
            return ["sourceTerm": pair[0], "targetTerm": pair[1]]
        }
    }

    private func mergeContinuity(_ terms: [SeriesTerm], into series: SeriesContext) {
        var merged: [String: SeriesTerm] = [:]
        let existing = inMemoryContinuity[series.id] ?? (settings.privateSession ? [] : seriesContinuityStore.terms(for: series.id))
        for term in existing {
            merged["\(term.sourceTerm.lowercased())\u{0}\(term.targetTerm.lowercased())"] = term
        }
        for term in terms where !term.sourceTerm.isEmpty && !term.targetTerm.isEmpty {
            merged["\(term.sourceTerm.lowercased())\u{0}\(term.targetTerm.lowercased())"] = term
        }
        let continuity = Array(merged.values).sorted { $0.confidence > $1.confidence }.prefix(500).map { $0 }
        inMemoryContinuity[series.id] = continuity
        if !settings.privateSession { seriesContinuityStore.save(continuity, for: series.id) }
    }

    private func recordSuccessfulTranslation(_ result: BrokerResult, series: SeriesContext, client: BrokerClient) {
        mergeContinuity(result.overlayRegions.compactMap { region in
            guard !region.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !region.translation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return SeriesTerm(sourceTerm: region.source, targetTerm: region.translation, confidence: region.confidence ?? 0.8)
        }, into: series)
        guard consent(for: series) == nil, !consentPromptInFlight.contains(series.id) else { return }
        consentPromptInFlight.insert(series.id)
        if settings.privateSession {
            privateSeriesConsents[series.id] = .declined
            return
        }
        let alert = UIAlertController(
            title: "Nhớ tên riêng cho bộ này?",
            message: "Từ trang sau, Comic Sub sẽ tự giữ cách gọi đã dịch. Bạn có thể cho phép tra cứu công khai theo tên bộ truyện và ngôn ngữ đích; không gửi URL chapter, ảnh, OCR hay lịch sử đọc.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cho phép tra cứu", style: .default) { [weak self] _ in
            self?.saveSeriesConsent(.granted, series: series, client: client)
        })
        alert.addAction(UIAlertAction(title: "Chỉ dùng liên tục cục bộ", style: .cancel) { [weak self] _ in
            self?.saveSeriesConsent(.declined, series: series, client: client)
        })
        present(alert, animated: true)
    }

    private func saveSeriesConsent(_ decision: SeriesResearchConsent, series: SeriesContext, client: BrokerClient) {
        seriesConsentStore.save(decision, for: series.id)
        settings.externalResearchAllowed = decision == .granted
        settingsStore.save(settings)
        Task { [weak self] in
            guard let self else { return }
            _ = try? await self.latestSeriesGlossary(client: client, series: series)
        }
    }

    private func pollSettled(client: BrokerClient, jobID: String) async throws -> BrokerJob {
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            try Task.checkCancellation()
            let job = try await client.job(jobID)
            if job.state == "SETTLED" { return job }
            if ["FAILED", "CANCELLED", "REJECTED", "EXPIRED"].contains(job.state) { throw BrokerError.request("Broker dừng job: \(job.state).") }
            try await Task.sleep(nanoseconds: 700_000_000)
        }
        throw BrokerError.request("Broker quá thời gian 3 phút.")
    }

    private func verifyReceipt(_ receipt: ModelReceipt, clientDevice: Bool) throws {
        guard receipt.modelMatched else { throw BrokerError.modelMismatch }
        if clientDevice {
            guard receipt.resolvedProvider == "apple", receipt.resolvedModel == "apple-translation" else { throw BrokerError.modelMismatch }
        } else {
            guard receipt.resolvedProvider == "gemini", receipt.resolvedModel == "gemini-3.6-flash" else { throw BrokerError.modelMismatch }
        }
    }

    private func origin(for url: URL) -> String {
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(url.scheme ?? "https")://\(url.host ?? "invalid")\(port)/"
    }

    private func cancelActiveTranslation(silent: Bool = false) {
        translationTask?.cancel(); translationHost?.dismiss(animated: true)
        let jobs = activeJobIDs; let broker = activeBroker
        activeJobIDs.removeAll()
        Task { for job in jobs { await broker?.cancel(job) } }
        if !silent { updateRouteStatus("Đang huỷ job; ảnh gốc vẫn hiển thị.") }
    }

    private func attachRendered(_ bytes: Data, mimeType: String, result: BrokerResult, to candidate: WebCandidate) {
        let assetURL = assetHandler.register(bytes, mimeType: mimeType)
        let label = result.overlayRegions.map(\.translation).filter { !$0.isEmpty }.joined(separator: ". ")
        let page = ["width": result.page.width, "height": result.page.height]
        let regions = (try? JSONEncoder().encode(result.overlayRegions)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        evaluateBridge("window.__comicSubReaderBridge && window.__comicSubReaderBridge.applyRendered(\(javascriptString(candidate.id)), \(javascriptString(assetURL.absoluteString)), \(javascriptString(label))); window.__comicSubReaderBridge && window.__comicSubReaderBridge.applyRegions(\(javascriptString(candidate.id)), \(regions), \(jsonObject(page)), true);")
    }

    private func attachRegions(_ result: BrokerResult, to candidate: WebCandidate) {
        let regions = (try? JSONEncoder().encode(result.overlayRegions)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let page = ["width": result.page.width, "height": result.page.height]
        evaluateBridge("window.__comicSubReaderBridge && window.__comicSubReaderBridge.applyRegions(\(javascriptString(candidate.id)), \(regions), \(jsonObject(page)), false);")
    }

    private func evaluateBridge(_ script: String) {
        webView.evaluateJavaScript(script) { [weak self] result, error in
            if error != nil || (result as? Bool) == false { self?.updateRouteStatus("Không gắn được overlay; ảnh gốc vẫn hiển thị.") }
        }
    }

    private func javascriptString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
        let array = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    private func jsonObject(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func translateOnDevice(_ texts: [String]) async throws -> [String] {
        guard !texts.isEmpty else { return [] }
        #if canImport(Translation) && canImport(SwiftUI)
        guard #available(iOS 18.0, *) else { throw BrokerError.request("Apple Translation cần iOS 18 trở lên.") }
        return try await withCheckedThrowingContinuation { continuation in
            let view = ClientRegionTranslationView(source: settings.sourceLanguage, target: settings.targetLanguage, texts: texts) { [weak self] result in
                self?.translationHost?.dismiss(animated: true)
                continuation.resume(with: result)
            }
            let host = UIHostingController(rootView: view)
            host.modalPresentationStyle = .formSheet
            translationHost = host
            present(host, animated: true)
        }
        #else
        throw BrokerError.request("SDK này không có Apple Translation.")
        #endif
    }

    private func presentLanguageDownload() {
        #if canImport(Translation) && canImport(SwiftUI)
        guard #available(iOS 18.0, *) else {
            showAlert(title: "Cần iOS mới hơn", message: "Apple Translation chỉ khả dụng từ iOS 18. Comic Sub sẽ không tự gửi trang lên Cloud.")
            return
        }
        let preparation = TranslationPreparationView(source: settings.sourceLanguage, target: settings.targetLanguage) { [weak self] success in
            guard let self else { return }
            self.updateRouteStatus(success ? "Gói ngôn ngữ đã sẵn sàng. Chọn Dịch lại để chạy tuyến on-device." : "Không tải được gói ngôn ngữ. Ảnh gốc vẫn đang đọc được.")
        }
        let host = UIHostingController(rootView: preparation)
        host.modalPresentationStyle = .formSheet
        present(host, animated: true)
        #else
        showAlert(title: "Không có Apple Translation", message: "SDK này không có Apple Translation. Comic Sub sẽ không tự gửi trang lên Cloud.")
        #endif
    }

    @objc private func showSettings() {
        let controller = ReaderSettingsController(settings: settings, token: settingsStore.loadToken(), brokerConnection: brokerConnectionLabel) { [weak self] updated, token, needsWebViewReset in
            guard let self else { return }
            let oldPrivate = self.settings.privateSession
            self.settings = updated
            self.settingsStore.save(updated)
            self.settingsStore.saveToken(token)
            if needsWebViewReset || oldPrivate != updated.privateSession {
                self.configureWebView(privateSession: updated.privateSession, preserving: self.webView.url)
            }
            self.updateRouteStatus(updated.privateSession ? "Phiên riêng tư: không lưu lịch sử." : "Đã lưu cài đặt cho thiết bị này.")
        }
        present(UINavigationController(rootViewController: controller), animated: true)
    }

    @objc private func showHistory() {
        let controller = HistoryViewController(history: historyStore.load(), privateSession: settings.privateSession) { [weak self] entry in
            guard let self, let url = URL(string: entry.url) else { return }
            self.homeCard.isHidden = true
            self.addressField.text = entry.url
            self.webView.load(URLRequest(url: url))
            self.currentAnchor = (entry.candidateID, entry.candidateIndex, entry.intraImageRatio, entry.fallbackScrollRatio)
            self.resumeURL = entry.url
        }
        present(UINavigationController(rootViewController: controller), animated: true)
    }

    private func updateRouteStatus(_ text: String) {
        let privacy = settings.privateSession ? " · Riêng tư" : ""
        statusLabel.text = "  \(text)\(privacy)  "
        statusLabel.accessibilityValue = text
    }

    private func currentRouteLabel() -> String {
        let target = settings.targetLanguage == "vi" ? "VI" : settings.targetLanguage.uppercased()
        switch settings.route {
        case .automatic: return "\(target) · Tự chọn"
        case .onDevice: return "\(target) · Văn bản trên thiết bị"
        case .privateServer: return "\(target) · Server riêng"
        case .managedCloud: return "\(target) · Managed Cloud"
        }
    }

    private var brokerEndpoint: String {
        discoveredBroker?.endpoint ?? (settings.endpoint.isEmpty ? ReaderSettings().endpoint : settings.endpoint)
    }

    private var brokerConnectionLabel: String {
        if let discoveredBroker { return "Mac: \(discoveredBroker.displayName)" }
        return URL(string: brokerEndpoint)?.host ?? "không hợp lệ"
    }

    private func saveCurrentProgress(force: Bool = false) {
        guard !settings.privateSession, let url = webView.url, url.scheme?.hasPrefix("http") == true else { return }
        saveTimer?.invalidate()
        let save = { [weak self] in
            guard let self else { return }
            let entry = ReadingHistoryEntry(
                id: UUID(), url: ReadingHistoryEntry.sanitizedURL(url), title: self.pageTitle.isEmpty ? (url.host ?? "Trang truyện") : self.pageTitle,
                candidateID: self.currentAnchor.id, candidateIndex: self.currentAnchor.index,
                intraImageRatio: self.currentAnchor.ratio, fallbackScrollRatio: self.currentAnchor.scrollRatio,
                targetLanguage: self.settings.targetLanguage, translated: self.isTranslatedSession, lastOpened: Date()
            )
            self.historyStore.upsert(entry, retentionDays: self.settings.historyRetentionDays)
        }
        if force { save() } else { saveTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { _ in save() } }
    }

    private func resumeIfNeeded() {
        guard let id = currentAnchor.id, let resumeURL,
              ReadingHistoryEntry.sanitizedURL(webView.url ?? URL(string: "about:blank")!) == resumeURL else { return }
        let escaped = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript("window.__comicSubReaderBridge && window.__comicSubReaderBridge.scrollToCandidate('" + escaped + "')") { [weak self] result, _ in
            guard let self else { return }
            if (result as? Bool) == true {
                self.updateRouteStatus("Đã tiếp tục gần vị trí đọc trước đó.")
                self.resumeURL = nil
            } else if self.currentAnchor.scrollRatio > 0 {
                self.webView.evaluateJavaScript("window.scrollTo(0, document.documentElement.scrollHeight * \(self.currentAnchor.scrollRatio));")
                self.updateRouteStatus("Trang đã thay đổi; đã khôi phục vị trí gần nhất.")
                self.resumeURL = nil
            }
        }
    }

    private func showAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Đã hiểu", style: .default))
        present(alert, animated: true)
    }

    // MARK: WKNavigationDelegate and page bridge

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        cancelActiveTranslation(silent: true)
        navigationID = "navigation-\(UUID().uuidString)"
        updateRouteStatus("Đang mở trang…")
        candidates = []
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        addressField.text = webView.url?.absoluteString
        backButton.isEnabled = webView.canGoBack
        forwardButton.isEnabled = webView.canGoForward
        updateRouteStatus("Đang tìm ảnh truyện — chưa gửi dữ liệu đi.")
        saveCurrentProgress()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        updateRouteStatus("Không mở được trang. Ảnh và lịch sử không bị gửi đi.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if ["http", "https", "about"].contains(url.scheme?.lowercased() ?? "") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "comicSubBridge", let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "candidates":
            pageTitle = body["title"] as? String ?? pageTitle
            guard let raw = body["candidates"], let data = try? JSONSerialization.data(withJSONObject: raw),
                  let decoded = try? JSONDecoder().decode([WebCandidate].self, from: data) else { return }
            candidates = decoded
            updateRouteStatus(decoded.isEmpty ? "Chưa thấy ảnh truyện phù hợp. Canvas/DRM có thể không được hỗ trợ." : "\(decoded.count) ảnh truyện sẵn sàng · \(currentRouteLabel())")
            resumeIfNeeded()
        case "anchor":
            currentAnchor = (
                body["id"] as? String,
                body["index"] as? Int ?? 0,
                body["ratio"] as? Double ?? 0,
                body["scrollRatio"] as? Double ?? 0
            )
            saveCurrentProgress()
        default: break
        }
    }
}

private final class ReaderSettingsController: UITableViewController {
    private var settings: ReaderSettings
    private var token: String
    private let brokerConnection: String
    private let onSave: (ReaderSettings, String, Bool) -> Void

    init(settings: ReaderSettings, token: String, brokerConnection: String, onSave: @escaping (ReaderSettings, String, Bool) -> Void) {
        self.settings = settings
        self.token = token
        self.brokerConnection = brokerConnection
        self.onSave = onSave
        super.init(style: .insetGrouped)
        title = "Cài đặt reader"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Xong", style: .done, target: self, action: #selector(done))
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(close))
    }

    @objc private func done() { onSave(settings, token, false); dismiss(animated: true) }
    @objc private func close() { dismiss(animated: true) }

    override func numberOfSections(in tableView: UITableView) -> Int { 6 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { [3, 3, 2, 2, 2, 1][section] }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        ["Ngôn ngữ", "Tuyến xử lý", "Riêng tư", "Thuật ngữ", "Lịch sử", "Hỗ trợ"][section]
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .value1, reuseIdentifier: nil)
        cell.accessoryType = .disclosureIndicator
        switch (indexPath.section, indexPath.row) {
        case (0, 0): cell.textLabel?.text = "Dịch sang"; cell.detailTextLabel?.text = languageName(settings.targetLanguage)
        case (0, 1): cell.textLabel?.text = "Nguồn"; cell.detailTextLabel?.text = languageName(settings.sourceLanguage)
        case (0, 2): cell.textLabel?.text = "Đọc trước"; cell.detailTextLabel?.text = "\(settings.lookAhead) ảnh"
        case (1, 0): cell.textLabel?.text = "Chế độ"; cell.detailTextLabel?.text = settings.route.title
        case (1, 1): cell.textLabel?.text = "Broker"; cell.detailTextLabel?.text = brokerConnection
        case (1, 2): cell.textLabel?.text = "Token broker"; cell.detailTextLabel?.text = token.isEmpty ? "Chưa có" : "Đã lưu trong Keychain"
        case (2, 0): cell.textLabel?.text = "Phiên riêng tư"; cell.accessoryType = .none; cell.accessoryView = switchView(isOn: settings.privateSession, action: #selector(togglePrivate(_:)))
        case (2, 1): cell.textLabel?.text = "Tra cứu tên từ web"; cell.accessoryType = .none; cell.accessoryView = switchView(isOn: settings.externalResearchAllowed, action: #selector(toggleResearch(_:)))
        case (3, 0): cell.textLabel?.text = "Glossary"; cell.detailTextLabel?.text = settings.glossary.isEmpty ? "Chưa có" : "Đã có \(settings.glossary.split(separator: "\n").count) mục"
        case (3, 1): cell.textLabel?.text = "Giải thích research"; cell.detailTextLabel?.text = "Chỉ tên truyện + ngôn ngữ"
        case (4, 0): cell.textLabel?.text = "Giữ lịch sử"; cell.detailTextLabel?.text = "\(settings.historyRetentionDays) ngày"
        case (4, 1): cell.textLabel?.text = "Xoá lịch sử"; cell.textLabel?.textColor = .systemRed; cell.detailTextLabel?.text = nil
        case (5, 0): cell.textLabel?.text = "Chẩn đoán tuyến dịch"; cell.detailTextLabel?.text = "Không chứa nội dung truyện"
        default: break
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        switch (indexPath.section, indexPath.row) {
        case (0, 0): choose("Dịch sang", values: [("vi", "Tiếng Việt"), ("en", "English"), ("ja", "日本語"), ("ko", "한국어")]) { self.settings.targetLanguage = $0 }
        case (0, 1): choose("Ngôn ngữ nguồn", values: [("zh-Hans", "中文 (Giản thể)"), ("zh-Hant", "中文 (Phồn thể)"), ("ja", "日本語"), ("ko", "한국어")]) { self.settings.sourceLanguage = $0 }
        case (0, 2): choose("Đọc trước", values: [("0", "0 ảnh"), ("1", "1 ảnh"), ("2", "2 ảnh"), ("3", "3 ảnh")]) { self.settings.lookAhead = Int($0) ?? 2 }
        case (1, 0): choose("Chế độ xử lý", values: ProcessingRoute.allCases.map { ($0.rawValue, $0.title) }) { self.settings.route = ProcessingRoute(rawValue: $0) ?? .automatic }
        case (1, 1): edit("Broker HTTPS dự phòng", initial: settings.endpoint, secure: false) { self.settings.endpoint = $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        case (1, 2): edit("Token broker", initial: token, secure: true) { self.token = $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        case (3, 0): edit("Glossary", initial: settings.glossary, secure: false) { self.settings.glossary = $0 }
        case (3, 1): showResearchDisclosure()
        case (4, 0): choose("Giữ lịch sử", values: [("30", "30 ngày"), ("90", "90 ngày"), ("365", "1 năm")]) { self.settings.historyRetentionDays = Int($0) ?? 90 }
        case (4, 1): confirmClearHistory()
        case (5, 0): showDiagnostics()
        default: break
        }
    }

    @objc private func togglePrivate(_ sender: UISwitch) { settings.privateSession = sender.isOn }
    @objc private func toggleResearch(_ sender: UISwitch) { settings.externalResearchAllowed = sender.isOn }

    private func switchView(isOn: Bool, action: Selector) -> UISwitch {
        let control = UISwitch(); control.isOn = isOn; control.addTarget(self, action: action, for: .valueChanged); return control
    }

    private func choose(_ title: String, values: [(String, String)], select: @escaping (String) -> Void) {
        let sheet = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
        values.forEach { value, label in sheet.addAction(UIAlertAction(title: label, style: .default) { _ in select(value); self.tableView.reloadData() }) }
        sheet.addAction(UIAlertAction(title: "Huỷ", style: .cancel))
        if let popover = sheet.popoverPresentationController { popover.sourceView = view; popover.sourceRect = view.bounds }
        present(sheet, animated: true)
    }

    private func edit(_ title: String, initial: String, secure: Bool, save: @escaping (String) -> Void) {
        let alert = UIAlertController(title: title, message: secure ? "Lưu trong Keychain; không đưa token vào trang web." : nil, preferredStyle: .alert)
        alert.addTextField { field in field.text = initial; field.isSecureTextEntry = secure; field.autocapitalizationType = .none; field.autocorrectionType = .no }
        alert.addAction(UIAlertAction(title: "Lưu", style: .default) { _ in save(alert.textFields?.first?.text ?? ""); self.tableView.reloadData() })
        alert.addAction(UIAlertAction(title: "Huỷ", style: .cancel))
        present(alert, animated: true)
    }

    private func showResearchDisclosure() {
        let alert = UIAlertController(title: "Tra cứu tên truyện", message: "Khi bật, Comic Sub chỉ có thể gửi tên truyện đã chuẩn hoá và ngôn ngữ đích tới nguồn đã kiểm duyệt để tìm cách gọi nhân vật/địa danh. Không gửi ảnh, OCR, URL chapter hay lịch sử đọc. Bạn có thể tắt hoặc xoá dữ liệu này bất cứ lúc nào.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Bật tra cứu", style: .default) { _ in self.settings.externalResearchAllowed = true; self.tableView.reloadData() })
        alert.addAction(UIAlertAction(title: "Chỉ dùng trên máy", style: .cancel) { _ in self.settings.externalResearchAllowed = false; self.tableView.reloadData() })
        present(alert, animated: true)
    }

    private func confirmClearHistory() {
        let alert = UIAlertController(title: "Xoá toàn bộ lịch sử?", message: "Không thể khôi phục vị trí đọc đã xoá.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Xoá lịch sử", style: .destructive) { _ in ReadingHistoryStore().clear() })
        alert.addAction(UIAlertAction(title: "Huỷ", style: .cancel))
        present(alert, animated: true)
    }

    private func showDiagnostics() {
        let endpoint = brokerConnection
        let route: String
        switch settings.route {
        case .automatic: route = "Tự chọn: không tự chuyển sang Cloud"
        case .onDevice: route = "Văn bản: Apple Translation khi gói có sẵn"
        case .privateServer: route = "Server riêng: \(endpoint)"
        case .managedCloud: route = "Managed Cloud: chưa gửi job tự động"
        }
        let alert = UIAlertController(
            title: "Chẩn đoán an toàn",
            message: "Tuyến: \(route)\nBroker: Bonjour Mac tự chọn khi có; server nhập tay chỉ HTTPS\nToken server: \(token.isEmpty ? "chưa lưu" : "đã lưu trong Keychain")\nBridge: chỉ metadata ảnh và vị trí đọc\nKhông có URL, ảnh, OCR, glossary hoặc secret trong màn hình này.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Đóng", style: .default))
        present(alert, animated: true)
    }

    private func languageName(_ value: String) -> String {
        ["vi": "Tiếng Việt", "en": "English", "ja": "日本語", "ko": "한국어", "zh-Hans": "中文 (Giản thể)", "zh-Hant": "中文 (Phồn thể)"][value] ?? value
    }
}

private final class HistoryViewController: UITableViewController {
    private let history: [ReadingHistoryEntry]
    private let privateSession: Bool
    private let open: (ReadingHistoryEntry) -> Void

    init(history: [ReadingHistoryEntry], privateSession: Bool, open: @escaping (ReadingHistoryEntry) -> Void) {
        self.history = history; self.privateSession = privateSession; self.open = open
        super.init(style: .insetGrouped)
        title = "Đọc tiếp"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() { super.viewDidLoad(); navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(close)) }
    @objc private func close() { dismiss(animated: true) }
    override func numberOfSections(in tableView: UITableView) -> Int { 1 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { history.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { privateSession ? "Phiên riêng tư không lưu lịch sử" : "Vị trí được lưu trên thiết bị này" }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let entry = history[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.text = entry.title
        let progress = entry.candidateIndex > 0 ? " · ảnh \(entry.candidateIndex + 1)" : ""
        cell.detailTextLabel?.text = "\(entry.translated ? "Đã dịch" : "Đang đọc")\(progress) · \(RelativeDateTimeFormatter().localizedString(for: entry.lastOpened, relativeTo: Date()))"
        cell.accessoryType = .disclosureIndicator
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { dismiss(animated: true) { self.open(self.history[indexPath.row]) } }
}
