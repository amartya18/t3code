import ExpoModulesCore

public final class T3DiagnosticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3Diagnostics")

    AsyncFunction("pending") { () -> [[String: String]] in
      DiagnosticStore.shared.pending()
    }

    AsyncFunction("remove") { (id: String) in
      DiagnosticStore.shared.remove(id)
    }
  }
}
