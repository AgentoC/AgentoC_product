#!/usr/bin/env swift

import Foundation
import AVFoundation
import Speech

struct Output: Codable {
    let text: String
    let timedOut: Bool
    let locale: String
}

func usage() -> Never {
    fputs("Usage: proactive-observer-listen-once.swift [--timeout-ms <ms>] [--locale <id>]\n", stderr)
    exit(1)
}

var timeoutMs = 30000
var localeId = Locale.current.identifier

var index = 1
while index < CommandLine.arguments.count {
    let arg = CommandLine.arguments[index]
    if arg == "--timeout-ms" {
      guard index + 1 < CommandLine.arguments.count else { usage() }
      timeoutMs = Int(CommandLine.arguments[index + 1]) ?? timeoutMs
      index += 2
      continue
    }
    if arg == "--locale" {
      guard index + 1 < CommandLine.arguments.count else { usage() }
      localeId = CommandLine.arguments[index + 1]
      index += 2
      continue
    }
    usage()
}

let locale = Locale(identifier: localeId)
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    fputs("Speech recognizer unavailable for locale \(localeId)\n", stderr)
    exit(2)
}

let authGroup = DispatchGroup()
var speechAuthorized = false
var micAuthorized = false

authGroup.enter()
SFSpeechRecognizer.requestAuthorization { status in
    speechAuthorized = (status == .authorized)
    authGroup.leave()
}

authGroup.enter()
AVCaptureDevice.requestAccess(for: .audio) { granted in
    micAuthorized = granted
    authGroup.leave()
}

authGroup.wait()

guard speechAuthorized else {
    fputs("Speech recognition permission denied\n", stderr)
    exit(3)
}

guard micAuthorized else {
    fputs("Microphone permission denied\n", stderr)
    exit(4)
}

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = false

let inputNode = audioEngine.inputNode
let format = inputNode.outputFormat(forBus: 0)
inputNode.removeTap(onBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}

var bestText = ""
var finished = false
var timedOut = false
let semaphore = DispatchSemaphore(value: 0)

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
        bestText = result.bestTranscription.formattedString
        if result.isFinal && !finished {
            finished = true
            semaphore.signal()
        }
    }
    if let error {
        if !finished {
            fputs("Speech recognition failed: \(error.localizedDescription)\n", stderr)
            finished = true
            semaphore.signal()
        }
    }
}

do {
    audioEngine.prepare()
    try audioEngine.start()
} catch {
    fputs("Failed to start audio engine: \(error.localizedDescription)\n", stderr)
    exit(5)
}

let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
if semaphore.wait(timeout: deadline) == .timedOut {
    timedOut = true
}

audioEngine.stop()
inputNode.removeTap(onBus: 0)
request.endAudio()
task.cancel()

let output = Output(
    text: bestText.trimmingCharacters(in: .whitespacesAndNewlines),
    timedOut: timedOut,
    locale: locale.identifier
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(output)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
