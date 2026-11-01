#!/usr/bin/env swift

import Foundation
import AppKit
import Vision

struct Output: Codable {
    let personPresent: Bool
    let confidence: Double
    let observationCount: Int
    let summary: String
    let imagePath: String
}

func usage() -> Never {
    fputs("Usage: proactive-observer-human-detect.swift --image <path> [--threshold <float>]\n", stderr)
    exit(1)
}

var imagePath = ""
var threshold = 0.2

var index = 1
while index < CommandLine.arguments.count {
    let arg = CommandLine.arguments[index]
    if arg == "--image" {
        guard index + 1 < CommandLine.arguments.count else { usage() }
        imagePath = CommandLine.arguments[index + 1]
        index += 2
        continue
    }
    if arg == "--threshold" {
        guard index + 1 < CommandLine.arguments.count else { usage() }
        threshold = Double(CommandLine.arguments[index + 1]) ?? threshold
        index += 2
        continue
    }
    usage()
}

if imagePath.isEmpty {
    usage()
}

let imageURL = URL(fileURLWithPath: imagePath)
guard let image = NSImage(contentsOf: imageURL) else {
    fputs("Failed to load image at \(imagePath)\n", stderr)
    exit(2)
}

var imageRect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &imageRect, context: nil, hints: nil) else {
    fputs("Failed to resolve CGImage for \(imagePath)\n", stderr)
    exit(3)
}

let request = VNDetectHumanRectanglesRequest()
request.upperBodyOnly = false

do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    let maxConfidence = observations.map { Double($0.confidence) }.max() ?? 0
    let personPresent = !observations.isEmpty && maxConfidence >= threshold
    let summary: String
    if personPresent {
        summary = "Detected a person in frame with confidence \(String(format: "%.2f", maxConfidence))."
    } else {
        summary = observations.isEmpty
            ? "No person detected in frame."
            : "Human-like regions detected below threshold; max confidence \(String(format: "%.2f", maxConfidence))."
    }
    let output = Output(
        personPresent: personPresent,
        confidence: maxConfidence,
        observationCount: observations.count,
        summary: summary,
        imagePath: imagePath
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(output)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fputs("Vision detection failed: \(error.localizedDescription)\n", stderr)
    exit(4)
}
