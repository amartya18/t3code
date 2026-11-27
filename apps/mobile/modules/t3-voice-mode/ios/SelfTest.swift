import AVFoundation
@_implementationOnly import FluidAudio
import Foundation

extension VoiceEngine {
  /// `dumpTo` keeps the 16 kHz audio for off-device comparison.
  func selfTest(dumpTo folder: URL? = nil) async throws -> String {
    let config = try requireConfig()
    let sentence = "Ask Kokoro to check the Tailscale link before FluidAudio downloads Parakeet."
    let words = ["Kokoro", "Tailscale", "FluidAudio", "Parakeet", "T3 Code"]
    var report: [String: Any] = [
      "os": ProcessInfo.processInfo.operatingSystemVersionString,
      "models": ModelStore.status(config),
      "expected": sentence,
      "words": words,
    ]
    guard ModelStore.isReady(config) else {
      report["ok"] = false
      return try selfTestJSON(report)
    }
    var errors: [String: String] = [:]
    var mark = Date()
    func lap() -> Int {
      defer { mark = Date() }
      return Int(Date().timeIntervalSince(mark) * 1000)
    }

    var speech: [Float] = []
    do {
      try await speaker.load(config)
      report["ttsLoadMs"] = lap()
      let spoken = try await speaker.synthesize(sentence)
      report["synthMs"] = lap()
      speech = try resampled(spoken.samples, rate: spoken.sampleRate)
      report["audioMs"] = speech.count / 16
    } catch {
      errors["tts"] = String(describing: error)
    }

    let lead = [Float](repeating: 0, count: 8_000)
    let trail = [Float](repeating: 0, count: 16_000)
    let heard = lead + speech + trail
    do {
      let vad = try SileroVad.load()
      report["vadLoadMs"] = lap()
      var gate = SpeechGate(settings: config.vad)
      var frames: [Double] = []
      var changes: [[String: Any]] = []
      var voiced: (from: Int, decidedAt: Int)?
      let frame = SileroVad.frameSamples
      for start in stride(from: 0, through: heard.count - frame, by: frame) {
        let window = heard[start..<start + frame]
        let probability = try vad.probability(window)
        frames.append((Double(probability) * 1000).rounded() / 1000)
        let energy = window.reduce(0) { $0 + Double($1 * $1) }
        if let change = gate.push(start: start, count: frame, probability: probability, energy: energy) {
          changes.append(["speaking": change.speaking, "ms": change.sample / 16, "level": Double(change.level)])
          if change.speaking, voiced == nil { voiced = (from: change.sample, decidedAt: start + frame) }
        }
      }
      report["vadMs"] = lap()
      report["vadFrames"] = frames
      report["vadChanges"] = changes
      report["vadSpeechFromMs"] = lead.count / 16
      if let voiced {
        // The wave's default floor plus active level in callWave.ts.
        let activeRms = 0.008
        let chunk = 1_600
        let lit = stride(from: 0, to: heard.count, by: chunk).first { start in
          MicLevel.windows(Array(heard[start..<min(start + chunk, heard.count)]), atMs: 0)
            .contains { Double($0.level) > activeRms }
        }
        let vadDelivered = (voiced.decidedAt + chunk - 1) / chunk * chunk
        report["meterActiveRms"] = activeRms
        report["tapChunkMs"] = chunk / 16
        report["vadReactMs"] = (vadDelivered - voiced.from) / 16
        if let lit { report["meterReactMs"] = (lit + chunk - voiced.from) / 16 }
      }
    } catch {
      errors["vad"] = String(describing: error)
    }

    do {
      try await turn.load()
      report["turnLoadMs"] = lap()
      var scores: [String: Double] = [:]
      scores["silence"] = Double(try await turn.probability(trail))
      if !speech.isEmpty {
        let sentence = try await turn.probability(speech + trail.prefix(3_200))
        let firstHalf = try await turn.probability(Array(speech.prefix(speech.count / 2)))
        scores["sentence"] = Double(sentence)
        scores["firstHalf"] = Double(firstHalf)
      }
      report["turnMs"] = lap()
      report["turn"] = scores
    } catch {
      errors["turn"] = String(describing: error)
    }

    if !speech.isEmpty {
      do {
        try await transcriber.load()
        report["asrLoadMs"] = lap()
        let previous = await transcriber.vocabulary
        try await transcriber.setVocabulary([])
        report["transcript"] = try await transcriber.transcribe(speech)
        report["transcribeMs"] = lap()
        try await transcriber.setVocabulary(words)
        report["vocabLoadMs"] = lap()
        report["vocabTranscript"] = try await transcriber.transcribe(speech)
        report["vocabTranscribeMs"] = lap()
        try await transcriber.setVocabulary(previous)
      } catch {
        errors["asr"] = String(describing: error)
      }
    }

    if let folder {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try heard.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: folder.appendingPathComponent("heard-16k-f32le.raw"))
    }
    report["errors"] = errors
    let transcript = report["transcript"] as? String ?? ""
    let started = (report["vadChanges"] as? [[String: Any]])?.contains { $0["speaking"] as? Bool == true } ?? false
    report["ok"] = errors.isEmpty && !transcript.isEmpty && started && report["meterReactMs"] != nil
    return try selfTestJSON(report)
  }
}

private func resampled(_ samples: [Float], rate: Int) throws -> [Float] {
  guard
    let format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false),
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
    let channel = buffer.floatChannelData?[0],
    let converter = MicConverter(from: format)
  else { throw VoiceModeError.make("bad_audio", "Kokoro returned no audio.") }
  buffer.frameLength = AVAudioFrameCount(samples.count)
  samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
  guard let converted = converter.convert(buffer, silence: false) else {
    throw VoiceModeError.make("bad_audio", "Kokoro's audio didn't convert to 16 kHz.")
  }
  return converted
}

func selfTestJSON(_ report: [String: Any]) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}
