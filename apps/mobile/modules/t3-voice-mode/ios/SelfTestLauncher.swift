import ExpoModulesCore
import Foundation
import UIKit

/// CI's only check of the model I/O before a device build: on a simulator launched with
/// T3_VOICE_SELF_TEST=1 the app downloads the models, prints one self-test line, keeps the test
/// audio in Caches/T3VoiceSelfTest and exits. Device builds never run it.
public class VoiceSelfTestLauncher: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    #if targetEnvironment(simulator)
      if ProcessInfo.processInfo.environment["T3_VOICE_SELF_TEST"] == "1" { Task.detached { await VoiceSelfTestLauncher.run() } }
    #endif
    return true
  }

  private static func run() async {
    let engine = VoiceEngine()
    let line: String
    do {
      await engine.configure(
        VoiceConfig(
          vad: .init(threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300), voiceId: "af_heart", speed: 1,
          vocoderFloat32: false, aec: false, logStages: false))
      let started = Date()
      try await engine.downloadModels()
      print("T3_VOICE_SELF_TEST_DOWNLOAD_MS \(Int(Date().timeIntervalSince(started) * 1000))")
      let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("T3VoiceSelfTest", isDirectory: true)
      line = try await engine.selfTest(dumpTo: folder)
    } catch {
      line = (try? selfTestJSON(["ok": false, "error": String(describing: error)])) ?? "{\"ok\":false}"
    }
    print("T3_VOICE_SELF_TEST \(line)")
    fflush(stdout)
    exit(0)
  }
}
