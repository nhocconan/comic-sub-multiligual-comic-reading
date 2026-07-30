import Foundation
import ImageIO
import Vision

struct OCRRegion: Codable {
    let id: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let rotation: Double
    let source: String
    let confidence: Double
}

struct OCRPage: Codable {
    let width: Double
    let height: Double
}

struct OCRResult: Codable {
    let page: OCRPage
    let regions: [OCRRegion]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

let language = CommandLine.arguments.dropFirst().first ?? "zh-Hans"
let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty, input.count <= 32 * 1024 * 1024 else {
    fail("OCR input must be between 1 byte and 32 MiB")
}
guard let source = CGImageSourceCreateWithData(input as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("Could not decode the comic image")
}

let recognitionLanguage: String
switch language {
case "zh-Hans": recognitionLanguage = "zh-Hans"
case "zh-Hant": recognitionLanguage = "zh-Hant"
case "ja": recognitionLanguage = "ja-JP"
case "ko": recognitionLanguage = "ko-KR"
default: recognitionLanguage = language
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if language == "auto" {
    request.automaticallyDetectsLanguage = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "ja-JP", "ko-KR", "en-US"]
} else {
    request.recognitionLanguages = [recognitionLanguage]
}
request.minimumTextHeight = 0.004

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("Vision OCR failed: \(error.localizedDescription)")
}

let imageWidth = Double(image.width)
let imageHeight = Double(image.height)
let regions = (request.results ?? []).prefix(200).compactMap { observation -> OCRRegion? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.count <= 2_000 else { return nil }
    let box = observation.boundingBox
    return OCRRegion(
        id: "vision-\(UUID().uuidString)",
        x: box.minX * imageWidth,
        y: (1 - box.maxY) * imageHeight,
        width: box.width * imageWidth,
        height: box.height * imageHeight,
        rotation: 0,
        source: text,
        confidence: Double(candidate.confidence)
    )
}

let result = OCRResult(
    page: OCRPage(width: imageWidth, height: imageHeight),
    regions: regions
)
do {
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
    fail("Could not encode OCR result")
}
