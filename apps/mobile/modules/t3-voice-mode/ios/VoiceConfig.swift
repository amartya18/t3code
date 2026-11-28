import ExpoModulesCore
import Foundation

struct VadConfigRecord: Record {
  @Field(.required) var threshold: Double = 0
  @Field(.required) var minSpeechMs: Int = 0
  @Field(.required) var minSilenceMs: Int = 0
}

struct TtsConfigRecord: Record {
  @Field(.required) var voiceId: String = ""
  @Field(.required) var speed: Double = 0
  @Field(.required) var vocoderFloat32: Bool = false
  @Field var gpu: Bool = false
}

struct VocabularyTermRecord: Record {
  @Field(.required) var text: String = ""
  @Field var aliases: [String] = []
  @Field var minSimilarity: Double?
}

struct AecConfigRecord: Record {
  @Field(.required) var enabled: Bool = false
}

struct VoiceEngineConfigRecord: Record {
  @Field(.required) var vad = VadConfigRecord()
  @Field(.required) var tts = TtsConfigRecord()
  @Field(.required) var aec = AecConfigRecord()
  @Field(.required) var logStages: Bool = false
}

struct VoiceConfig: Equatable {
  let vad: SpeechGate.Settings
  let voiceId: String
  let speed: Float
  let vocoderFloat32: Bool
  /// Kokoro's noise and tail stages on the GPU; iOS refuses GPU work while the app is in the background.
  let kokoroGpu: Bool
  let aec: Bool
  let logStages: Bool
}

extension VoiceConfig {
  init(_ record: VoiceEngineConfigRecord) throws {
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
    self.init(
      vad: SpeechGate.Settings(
        threshold: Float(record.vad.threshold), minSpeechMs: Double(record.vad.minSpeechMs),
        minSilenceMs: Double(record.vad.minSilenceMs)),
      voiceId: voice, speed: Float(record.tts.speed), vocoderFloat32: record.tts.vocoderFloat32,
      kokoroGpu: record.tts.gpu, aec: record.aec.enabled, logStages: record.logStages)
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
