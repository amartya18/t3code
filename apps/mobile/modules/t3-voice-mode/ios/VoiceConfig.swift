import ExpoModulesCore
import FluidAudio
import Foundation

struct AsrConfigRecord: Record {
  @Field(.required) var chunkMs: Int = 0
  @Field(.required) var eouDebounceMs: Int = 0
}

struct VadConfigRecord: Record {
  @Field(.required) var threshold: Double = 0
  @Field(.required) var minSpeechMs: Int = 0
  @Field(.required) var minSilenceMs: Int = 0
}

struct TtsConfigRecord: Record {
  @Field(.required) var voiceId: String = ""
  @Field(.required) var speed: Double = 0
  @Field(.required) var vocoderFloat32: Bool = false
}

struct AecConfigRecord: Record {
  @Field(.required) var enabled: Bool = false
}

struct VoiceEngineConfigRecord: Record {
  @Field(.required) var asr = AsrConfigRecord()
  @Field(.required) var vad = VadConfigRecord()
  @Field(.required) var tts = TtsConfigRecord()
  @Field(.required) var aec = AecConfigRecord()
  @Field(.required) var logStages: Bool = false
}

struct VadSettings: Equatable {
  let threshold: Float
  let minSpeechSamples: Int
  let minSilenceSeconds: Double
}

struct VoiceConfig: Equatable {
  let chunkSize: StreamingChunkSize
  let eouDebounceMs: Int
  let vad: VadSettings
  let voiceId: String
  let speed: Float
  let vocoderFloat32: Bool
  let aec: Bool
  let logStages: Bool

  var asrRepo: Repo { chunkSize == .ms160 ? .parakeetEou160 : .parakeetEou320 }

  init(_ record: VoiceEngineConfigRecord) throws {
    switch record.asr.chunkMs {
    case 160: chunkSize = .ms160
    case 320: chunkSize = .ms320
    default: throw VoiceModeError.invalidConfig("asr.chunkMs must be 160 or 320")
    }
    guard record.asr.eouDebounceMs >= 0 else { throw VoiceModeError.invalidConfig("asr.eouDebounceMs must be >= 0") }
    guard record.vad.threshold > 0, record.vad.threshold <= 1 else {
      throw VoiceModeError.invalidConfig("vad.threshold must be in (0, 1]")
    }
    guard record.vad.minSpeechMs >= 0, record.vad.minSilenceMs >= 0 else {
      throw VoiceModeError.invalidConfig("vad.minSpeechMs and vad.minSilenceMs must be >= 0")
    }
    let voice = record.tts.voiceId
    guard !voice.isEmpty, voice.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else {
      throw VoiceModeError.invalidConfig("tts.voiceId must be letters, digits and underscores")
    }
    guard record.tts.speed > 0 else { throw VoiceModeError.invalidConfig("tts.speed must be > 0") }
    eouDebounceMs = record.asr.eouDebounceMs
    vad = VadSettings(
      threshold: Float(record.vad.threshold),
      minSpeechSamples: record.vad.minSpeechMs * VadManager.sampleRate / 1000,
      minSilenceSeconds: Double(record.vad.minSilenceMs) / 1000)
    voiceId = voice
    speed = Float(record.tts.speed)
    vocoderFloat32 = record.tts.vocoderFloat32
    aec = record.aec.enabled
    logStages = record.logStages
  }
}

enum VoiceModeError {
  static func invalidConfig(_ message: String) -> Exception { make("invalid_config", message) }
  static let notConfigured = make("not_configured", "Call configure() first.")
  static let notStarted = make("not_started", "Call start() first.")
  static let busy = make("busy", "Stop the engine first.")
  static let permissionDenied = make("permission_denied", "Microphone access was denied.")
  static let modelsMissing = make("models_missing", "Download the voice models first.")
  static let noInput = make("no_input", "No microphone input is available.")

  static func make(_ code: String, _ message: String) -> Exception {
    Exception(name: "VoiceModeError", description: message, code: code)
  }
}
