import Foundation
import NaturalLanguage
import Translation

struct TranslationRequest: Codable {
    let id: String
    let text: String
}

struct TranslationInput: Codable {
    let sourceLanguage: String
    let targetLanguage: String
    let requests: [TranslationRequest]
}

struct TranslationItem: Codable {
    let id: String
    let text: String
}

struct TranslationOutput: Codable {
    let availability: String
    let translations: [TranslationItem]
}

enum HelperError: LocalizedError {
    case invalidInput(String)
    case unsupported
    case notInstalled

    var errorDescription: String? {
        switch self {
        case .invalidInput(let message):
            return message
        case .unsupported:
            return "The selected language pair is not supported by Apple Translation."
        case .notInstalled:
            return "The selected language pack is not installed. Download it in System Settings > General > Language & Region > Translation Languages."
        }
    }
}

func writeError(_ error: Error) -> Never {
    let message = (error as? LocalizedError)?.errorDescription
        ?? error.localizedDescription
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

@main
struct MangaSubTranslation {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            writeError(HelperError.invalidInput("On-device translation requires macOS 26 or newer."))
        }

        do {
            let bytes = FileHandle.standardInput.readDataToEndOfFile()
            guard !bytes.isEmpty, bytes.count <= 4 * 1024 * 1024 else {
                throw HelperError.invalidInput("Translation input must be between 1 byte and 4 MiB.")
            }
            let input = try JSONDecoder().decode(TranslationInput.self, from: bytes)
            guard !input.sourceLanguage.isEmpty, !input.targetLanguage.isEmpty else {
                throw HelperError.invalidInput("Source and target languages are required.")
            }
            guard input.requests.count <= 1_000 else {
                throw HelperError.invalidInput("A translation batch may contain at most 1,000 text regions.")
            }

            var seen = Set<String>()
            var characterCount = 0
            for request in input.requests {
                guard !request.id.isEmpty,
                      request.id.count <= 512,
                      request.text.count <= 10_000,
                      seen.insert(request.id).inserted else {
                    throw HelperError.invalidInput("Translation request IDs and text must be unique and bounded.")
                }
                characterCount += request.text.count
            }
            guard characterCount <= 120_000 else {
                throw HelperError.invalidInput("A translation batch may contain at most 120,000 characters.")
            }

            let detectedSource: String
            if input.sourceLanguage == "auto" {
                let recognizer = NLLanguageRecognizer()
                recognizer.processString(input.requests.map(\.text).joined(separator: "\n"))
                guard let language = recognizer.dominantLanguage else {
                    throw HelperError.invalidInput("Apple could not detect the source language. Choose it explicitly in Settings.")
                }
                detectedSource = language.rawValue
            } else {
                detectedSource = input.sourceLanguage
            }
            let source = Locale.Language(identifier: detectedSource)
            let target = Locale.Language(identifier: input.targetLanguage)
            if source == target {
                let output = TranslationOutput(
                    availability: "installed",
                    translations: input.requests.map {
                        TranslationItem(id: $0.id, text: $0.text)
                    }
                )
                FileHandle.standardOutput.write(try JSONEncoder().encode(output))
                return
            }
            let status = await LanguageAvailability().status(from: source, to: target)
            switch status {
            case .unsupported:
                throw HelperError.unsupported
            case .supported:
                throw HelperError.notInstalled
            case .installed:
                break
            @unknown default:
                throw HelperError.unsupported
            }

            guard !input.requests.isEmpty else {
                let output = TranslationOutput(availability: "installed", translations: [])
                FileHandle.standardOutput.write(try JSONEncoder().encode(output))
                return
            }

            let session = TranslationSession(installedSource: source, target: target)
            let batch = input.requests.map {
                TranslationSession.Request(sourceText: $0.text, clientIdentifier: $0.id)
            }
            let responses = try await session.translations(from: batch)
            let translations = responses.compactMap { response -> TranslationItem? in
                guard let id = response.clientIdentifier else { return nil }
                return TranslationItem(id: id, text: response.targetText)
            }
            guard translations.count == input.requests.count,
                  Set(translations.map(\.id)) == seen else {
                throw HelperError.invalidInput("Apple Translation returned an incomplete batch.")
            }
            let output = TranslationOutput(
                availability: "installed",
                translations: translations
            )
            FileHandle.standardOutput.write(try JSONEncoder().encode(output))
        } catch {
            writeError(error)
        }
    }
}
