import ExpoModulesCore
import MetricKit

final class DiagnosticPayloadReceiver: NSObject, MXMetricManagerSubscriber, Sendable {
  static let shared = DiagnosticPayloadReceiver()

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for payload in payloads {
      DiagnosticStore.shared.save(payload.jsonRepresentation())
    }
  }
}

// Registers at launch, before JS loads, so a report MetricKit delivers early is still kept.
public final class T3DiagnosticsSubscriber: ExpoAppDelegateSubscriber {
  private static let importedPastKey = "T3DiagnosticsImportedPastPayloads"

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    MXMetricManager.shared.add(DiagnosticPayloadReceiver.shared)
    // Reports from before this subscriber existed; later launches get theirs through didReceive.
    if !UserDefaults.standard.bool(forKey: Self.importedPastKey) {
      UserDefaults.standard.set(true, forKey: Self.importedPastKey)
      DispatchQueue.global(qos: .utility).async {
        DiagnosticPayloadReceiver.shared.didReceive(MXMetricManager.shared.pastDiagnosticPayloads)
      }
    }
    return true
  }
}
