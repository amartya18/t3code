import Foundation

// Built with swiftc next to AudioRing.swift and SpeechGate.swift by fork-ios-compile.yml.

var failures = 0

func check(_ condition: Bool, _ message: String, line: Int = #line) {
  if !condition {
    failures += 1
    print("FAIL line \(line): \(message)")
  }
}

func ramp(_ count: Int, from start: Int) -> [Float] {
  (0..<count).map { Float(start + $0) }
}

do {
  let ring = AudioRing(seconds: 1)
  check(ring.samples(fromMs: 0, toMs: 1000).isEmpty, "an empty ring reads nothing")

  let first = ring.append(ramp(1600, from: 0), atMs: 1000)
  let second = ring.append(ramp(1600, from: 1600), atMs: 1100)
  check(first == 0 && second == 1600, "indices count every sample")
  check(ring.ms(at: 800) == 1050, "a sample's time follows its buffer's anchor")
  check(ring.ms(at: 2400) == 1150, "the second buffer has its own anchor")

  let middle = ring.samples(fromMs: 1050, toMs: 1150)
  check(middle == ramp(1600, from: 800), "a range spans buffers: \(middle.first ?? -1)…\(middle.last ?? -1)")
  check(ring.samples(fromMs: 0, toMs: 5000) == ramp(3200, from: 0), "ranges outside the ring are clamped")
  check(ring.samples(fromMs: 1150, toMs: 1050).isEmpty, "a reversed range is empty")

  _ = ring.append(ramp(16_000, from: 3200), atMs: 1200)
  let all = ring.samples(fromMs: 0, toMs: 10_000)
  check(all.count == 16_000 && all.first == 3200 && all.last == 19_199, "the ring keeps only its capacity")
  check(ring.samples(fromMs: 1000, toMs: 1100).isEmpty, "overwritten audio is gone")

  let gap = ring.append(ramp(1600, from: 19_200), atMs: 5000)
  check(ring.ms(at: gap) == 5000, "a restart re-anchors the clock")
  let acrossGap = ring.samples(fromMs: 2150, toMs: 5050)
  check(acrossGap.count == 800 + 800, "a range across a gap joins the audio on both sides: \(acrossGap.count)")

  ring.clear()
  check(ring.samples(fromMs: 0, toMs: 10_000).isEmpty, "clear forgets the audio")
  let afterClear = ring.append(ramp(160, from: 0), atMs: 6000)
  check(afterClear == gap + 1600, "indices keep counting after clear")
  check(ring.samples(fromMs: 6000, toMs: 6010).count == 160, "audio after clear reads back")
}

do {
  let frame = 512
  let settings = SpeechGate.Settings(threshold: 0.5, minSpeechMs: 96, minSilenceMs: 64)
  var gate = SpeechGate(settings: settings)
  var changes: [SpeechGate.Change] = []
  let probabilities: [Float] = [0.1, 0.9, 0.9, 0.1, 0.9, 0.8, 0.7, 0.9, 0.2, 0.9, 0.1, 0.1, 0.1]
  for (i, probability) in probabilities.enumerated() {
    if let change = gate.push(start: i * frame, count: frame, probability: probability, energy: 0.25 * Double(frame)) {
      changes.append(change)
    }
  }
  check(changes.count == 2, "a short blip and a short dip change nothing: \(changes)")
  check(changes.first?.speaking == true && changes.first?.sample == 4 * frame, "speech starts at its first voiced frame")
  check(abs((changes.first?.probability ?? 0) - 0.8) < 0.0001, "the start carries the run's mean probability")
  check(abs((changes.first?.level ?? 0) - 0.5) < 0.0001, "the level is the run's RMS")
  check(changes.last?.speaking == false && changes.last?.sample == 10 * frame, "speech ends after its last voiced frame")

  var held = SpeechGate(settings: settings)
  _ = held.push(start: 0, count: frame, probability: 0.9, energy: 0)
  _ = held.push(start: frame, count: frame, probability: 0.9, energy: 0)
  let start = held.push(start: 2 * frame, count: frame, probability: 0.9, energy: 0)
  check(start?.speaking == true && start?.sample == 0, "three 32 ms frames hold 96 ms")
  _ = held.push(start: 3 * frame, count: frame, probability: 0.1, energy: 0)
  let reset = held.reset()
  check(reset?.speaking == false && reset?.sample == 3 * frame, "reset ends speech after its last voiced frame")
  check(held.reset() == nil, "a second reset has nothing to end")

  var instant = SpeechGate(settings: .init(threshold: 0.5, minSpeechMs: 0, minSilenceMs: 0))
  check(instant.push(start: 0, count: frame, probability: 0.5, energy: 0)?.speaking == true, "zero hold starts at once")
  check(instant.push(start: frame, count: frame, probability: 0.4, energy: 0)?.speaking == false, "zero hold ends at once")
}

if failures > 0 {
  print("\(failures) check(s) failed")
  exit(1)
}
print("voice logic checks passed")
