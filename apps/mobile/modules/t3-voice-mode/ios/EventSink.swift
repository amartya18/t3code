import ExpoModulesCore
import Foundation

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Thread-safe path from any actor or audio thread to JS events.
final class EventSink: @unchecked Sendable {
  private let lock = NSLock()
  private weak var module: T3VoiceModeModule?
  private var logStages = false

  func attach(_ module: T3VoiceModeModule) {
    lock.withLock { self.module = module }
  }

  func setLogStages(_ enabled: Bool) {
    lock.withLock { logStages = enabled }
  }

  func send(_ name: String, _ body: [String: Any?]) {
    lock.withLock { module }?.sendEvent(name, body)
  }

  func stage(_ name: String) {
    guard lock.withLock({ logStages }) else { return }
    send("stage", ["name": name, "atMs": nowMs()])
  }

  func error(_ code: String, _ error: Error) {
    send("error", ["code": code, "message": String(describing: error)])
  }

  func playback(_ id: String, _ state: String) {
    send("playback", ["id": id, "state": state])
  }
}

/// State the synchronous JS calls change at once, read from the audio thread and the actors.
final class Controls: @unchecked Sendable {
  private let lock = NSLock()
  private var _muted = false
  private var _volume: Float = 1
  private var _stopBefore = 0

  var muted: Bool {
    get { lock.withLock { _muted } }
    set { lock.withLock { _muted = newValue } }
  }

  var volume: Float {
    get { lock.withLock { _volume } }
    set { lock.withLock { _volume = newValue } }
  }

  var stopBefore: Int { lock.withLock { _stopBefore } }

  func stop(before seq: Int) {
    lock.withLock { _stopBefore = max(_stopBefore, seq) }
  }
}
