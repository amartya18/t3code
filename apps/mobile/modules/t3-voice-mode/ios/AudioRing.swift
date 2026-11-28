import Foundation

/// The last stretch of 16 kHz mono mic audio, stamped on the engine clock. Sample indices count
/// every sample since creation and never reset, so an index taken before `clear()` stays unambiguous.
final class AudioRing: @unchecked Sendable {
  static let samplesPerMs = 16.0

  private struct Anchor {
    let index: Int
    let ms: Double
  }

  private let lock = NSLock()
  private var storage: [Float]
  private var written = 0
  private var oldest = 0
  private var anchors: [Anchor] = []

  init(seconds: Int) {
    storage = Array(repeating: 0, count: seconds * Int(Self.samplesPerMs) * 1000)
  }

  func clear() {
    lock.withLock {
      oldest = written
      anchors.removeAll()
    }
  }

  /// Stores samples whose first one was captured at `ms` and returns that sample's index.
  func append(_ samples: [Float], atMs ms: Double) -> Int {
    lock.withLock {
      let start = written
      guard !samples.isEmpty else { return start }
      let capacity = storage.count
      let kept = samples.suffix(capacity)
      var position = (start + samples.count - kept.count) % capacity
      storage.withUnsafeMutableBufferPointer { ring in
        kept.withUnsafeBufferPointer { source in
          var offset = 0
          while offset < source.count {
            let count = min(source.count - offset, capacity - position)
            ring.baseAddress!.advanced(by: position)
              .update(from: source.baseAddress!.advanced(by: offset), count: count)
            offset += count
            position = (position + count) % capacity
          }
        }
      }
      written += samples.count
      oldest = max(oldest, written - capacity)
      anchors.append(Anchor(index: start, ms: max(ms, anchors.last?.ms ?? ms)))
      while anchors.count > 1, anchors[1].index <= oldest { anchors.removeFirst() }
      return start
    }
  }

  func ms(at index: Int) -> Double {
    lock.withLock {
      guard let anchor = anchors.last(where: { $0.index <= index }) ?? anchors.first else { return 0 }
      return anchor.ms + Double(index - anchor.index) / Self.samplesPerMs
    }
  }

  /// The stored audio between two engine times, clamped to what the ring still holds.
  func samples(fromMs: Double, toMs: Double) -> [Float] {
    lock.withLock {
      let start = index(atMs: fromMs)
      let end = index(atMs: toMs)
      guard end > start else { return [] }
      let capacity = storage.count
      return (start..<end).map { storage[$0 % capacity] }
    }
  }

  private func index(atMs ms: Double) -> Int {
    guard let position = anchors.lastIndex(where: { $0.ms <= ms }) else { return oldest }
    let anchor = anchors[position]
    let segmentEnd = position + 1 < anchors.count ? anchors[position + 1].index : written
    let index = anchor.index + Int(((ms - anchor.ms) * Self.samplesPerMs).rounded())
    return min(max(index, oldest, anchor.index), segmentEnd, written)
  }
}
