#!/usr/bin/env swift

import Foundation
import AVFoundation
import Speech

struct Options {
    let timeoutMs: Int
    let speechStartTimeoutMs: Int
    let silenceMs: Int
    let localeId: String
    let onDevice: Bool
    let allowServerFallback: Bool
    let voiceThresholdDb: Float
}

struct CaptureOutput: Codable {
    let transcript: String
    let text: String
    let timedOut: Bool
    let speechStarted: Bool
    let silenceTriggered: Bool
    let locale: String
    let onDevice: Bool
}

enum FinishReason {
    case timeout
    case speechStartTimeout
    case silence
    case finalResult
    case signal
}

func usage() -> Never {
    fputs("Usage: voice-capture-until-silence.swift [--timeout-ms <ms>] [--speech-start-timeout-ms <ms>] [--silence-ms <ms>] [--locale <id>] [--on-device <true|false>] [--allow-server-fallback <true|false>] [--voice-threshold-db <db>]\n", stderr)
    exit(1)
}

func trim(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
}

func parseBool(_ value: String?) -> Bool? {
    guard let value else { return nil }
    switch trim(value).lowercased() {
    case "1", "true", "yes", "on":
        return true
    case "0", "false", "no", "off":
        return false
    default:
        return nil
    }
}

final class CaptureSession {
    private let options: Options
    private let recognizer: SFSpeechRecognizer
    private let usingOnDevice: Bool
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var timer: DispatchSourceTimer?
    private var bestTranscript = ""
    private var startedAt = Date()
    private var lastVoiceAt = Date()
    private var speechStarted = false
    private var finished = false

    init(options: Options, recognizer: SFSpeechRecognizer, usingOnDevice: Bool) {
        self.options = options
        self.recognizer = recognizer
        self.usingOnDevice = usingOnDevice
    }

    func start() {
        startedAt = Date()
        lastVoiceAt = startedAt

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = usingOnDevice
        recognitionRequest = request

        audioEngine = AVAudioEngine()
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.recognitionRequest?.append(buffer)
            let db = self.peakLevelDb(buffer: buffer)
            DispatchQueue.main.async {
                self.handleAudioLevel(db)
            }
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let transcript = trim(result.bestTranscription.formattedString)
                DispatchQueue.main.async {
                    self.bestTranscript = transcript
                    if result.isFinal {
                        self.finish(.finalResult)
                    }
                }
            }

            if let error {
                let message = trim(error.localizedDescription)
                if !message.isEmpty {
                    fputs("[voice-capture] recognition error: \(message)\n", stderr)
                }
                DispatchQueue.main.async {
                    self.finish(.finalResult)
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            fputs("[voice-capture] failed to start audio engine: \(error.localizedDescription)\n", stderr)
            exit(5)
        }

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            self?.evaluateStopConditions()
        }
        timer.resume()
        self.timer = timer
    }

    func stopFromSignal() {
        finish(.signal)
    }

    private func handleAudioLevel(_ db: Float) {
        guard !finished else { return }
        if db >= options.voiceThresholdDb {
            speechStarted = true
            lastVoiceAt = Date()
        }
    }

    private func evaluateStopConditions() {
        guard !finished else { return }
        let now = Date()
        if now.timeIntervalSince(startedAt) * 1000 >= Double(options.timeoutMs) {
            finish(.timeout)
            return
        }
        if !speechStarted && now.timeIntervalSince(startedAt) * 1000 >= Double(options.speechStartTimeoutMs) {
            finish(.speechStartTimeout)
            return
        }
        if speechStarted && !bestTranscript.isEmpty && now.timeIntervalSince(lastVoiceAt) * 1000 >= Double(options.silenceMs) {
            finish(.silence)
        }
    }

    private func finish(_ reason: FinishReason) {
        guard !finished else { return }
        finished = true
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil

        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)

        let transcript = trim(bestTranscript)
        let output = CaptureOutput(
            transcript: transcript,
            text: transcript,
            timedOut: reason == .timeout || reason == .speechStartTimeout,
            speechStarted: speechStarted,
            silenceTriggered: reason == .silence,
            locale: options.localeId,
            onDevice: usingOnDevice
        )

        let encoder = JSONEncoder()
        do {
            let data = try encoder.encode(output)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            fputs("[voice-capture] failed to encode capture output: \(error.localizedDescription)\n", stderr)
        }

        CFRunLoopStop(CFRunLoopGetMain())
    }

    private func peakLevelDb(buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return -160 }
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        if channelCount == 0 || frameLength == 0 { return -160 }

        var peak: Float = 0
        for channel in 0..<channelCount {
            let samples = channelData[channel]
            for frame in 0..<frameLength {
                peak = max(peak, abs(samples[frame]))
            }
        }

        if peak <= 0 {
            return -160
        }
        return 20 * log10(peak)
    }
}

func installSignalHandlers(onSignal: @escaping () -> Void) -> [DispatchSourceSignal] {
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigintSource.setEventHandler(handler: onSignal)
    sigintSource.resume()

    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigtermSource.setEventHandler(handler: onSignal)
    sigtermSource.resume()

    return [sigintSource, sigtermSource]
}

var timeoutMs = 20000
var speechStartTimeoutMs = 8000
var silenceMs = 1000
var localeId = "en-US"
var onDevice = true
var allowServerFallback = true
var voiceThresholdDb: Float = -38

var index = 1
while index < CommandLine.arguments.count {
    let arg = CommandLine.arguments[index]
    switch arg {
    case "--timeout-ms":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        timeoutMs = Int(CommandLine.arguments[index + 1]) ?? timeoutMs
        index += 2
    case "--speech-start-timeout-ms":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        speechStartTimeoutMs = Int(CommandLine.arguments[index + 1]) ?? speechStartTimeoutMs
        index += 2
    case "--silence-ms":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        silenceMs = Int(CommandLine.arguments[index + 1]) ?? silenceMs
        index += 2
    case "--locale":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        localeId = trim(CommandLine.arguments[index + 1])
        index += 2
    case "--on-device":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        onDevice = parseBool(CommandLine.arguments[index + 1]) ?? onDevice
        index += 2
    case "--allow-server-fallback":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        allowServerFallback = parseBool(CommandLine.arguments[index + 1]) ?? allowServerFallback
        index += 2
    case "--voice-threshold-db":
        guard index + 1 < CommandLine.arguments.count else { usage() }
        voiceThresholdDb = Float(CommandLine.arguments[index + 1]) ?? voiceThresholdDb
        index += 2
    case "--help", "-h":
        usage()
    default:
        usage()
    }
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

let usingOnDevice: Bool
if onDevice && recognizer.supportsOnDeviceRecognition {
    usingOnDevice = true
} else if onDevice && !allowServerFallback {
    fputs("On-device recognition is unavailable for locale \(localeId)\n", stderr)
    exit(5)
} else {
    usingOnDevice = false
    if onDevice {
        fputs("[voice-capture] on-device recognition unavailable; falling back for locale \(localeId)\n", stderr)
    }
}

let options = Options(
    timeoutMs: timeoutMs,
    speechStartTimeoutMs: speechStartTimeoutMs,
    silenceMs: silenceMs,
    localeId: localeId,
    onDevice: onDevice,
    allowServerFallback: allowServerFallback,
    voiceThresholdDb: voiceThresholdDb
)

let session = CaptureSession(options: options, recognizer: recognizer, usingOnDevice: usingOnDevice)
let signalSources = installSignalHandlers {
    session.stopFromSignal()
}
session.start()
withExtendedLifetime(signalSources) {
    RunLoop.main.run()
}
