import AVFoundation
import FluidAudio
import Foundation

extension VoiceEngine {
  /// Speaks a sentence with Kokoro and hears it back with a fresh Parakeet instance: no bundled audio, no mic.
  func selfTest() async throws -> String {
    let config = try requireConfig()
    let sentence = "The quick brown fox jumps over the lazy dog."
    var report: [String: Any] = [
      "os": ProcessInfo.processInfo.operatingSystemVersionString,
      "models": ModelStore.status(config),
      "expected": sentence,
    ]
    guard ModelStore.isReady(config) else {
      report["ok"] = false
      return try json(report)
    }

    var mark = Date()
    func lap() -> Int {
      defer { mark = Date() }
      return Int(Date().timeIntervalSince(mark) * 1000)
    }

    try await speaker.load(config)
    report["ttsLoadMs"] = lap()
    let speech = try await speaker.synthesize(sentence)
    report["synthMs"] = lap()
    report["audioMs"] = speech.samples.count * 1000 / max(speech.sampleRate, 1)

    let asr = StreamingEouAsrManager(chunkSize: config.chunkSize, eouDebounceMs: config.eouDebounceMs)
    try await asr.loadModels(to: ModelStore.root)
    report["asrLoadMs"] = lap()
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(speech.sampleRate), channels: 1, interleaved: false),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(speech.samples.count)),
      let channel = buffer.floatChannelData?[0]
    else { throw VoiceModeError.make("bad_audio", "Kokoro returned no audio.") }
    buffer.frameLength = AVAudioFrameCount(speech.samples.count)
    speech.samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: speech.samples.count) }
    try await asr.appendAudio(buffer)
    try await asr.processBufferedAudio()
    let heard = try await asr.finish()
    await asr.cleanup()
    report["transcribeMs"] = lap()
    report["transcript"] = heard
    report["ok"] = normalized(heard) == normalized(sentence)
    return try json(report)
  }
}

private func normalized(_ text: String) -> String {
  text.lowercased()
    .filter { $0.isLetter || $0.isNumber || $0 == " " }
    .split(separator: " ")
    .joined(separator: " ")
}

private func json(_ report: [String: Any]) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}
