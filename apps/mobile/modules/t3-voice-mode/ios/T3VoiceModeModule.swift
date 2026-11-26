import ExpoModulesCore

public final class T3VoiceModeModule: Module {
  private let engine = VoiceEngine()

  public func definition() -> ModuleDefinition {
    Name("T3VoiceMode")
    Events("vad", "partial", "eou", "playback", "models", "route", "interruption", "stage", "error")

    OnCreate {
      self.engine.events.attach(self)
    }

    OnDestroy {
      let engine = self.engine
      Task { await engine.stop() }
    }

    AsyncFunction("configure") { (record: VoiceEngineConfigRecord) async throws in
      let config = try VoiceConfig(record)
      await self.engine.configure(config)
    }

    AsyncFunction("modelStatus") { () async throws -> [String: Any] in
      try await self.engine.modelStatus()
    }

    AsyncFunction("downloadModels") { () async throws in
      try await self.engine.downloadModels()
    }

    AsyncFunction("deleteModels") { () async throws in
      try await self.engine.deleteModels()
    }

    AsyncFunction("start") { () async throws in
      try await self.engine.start()
    }

    AsyncFunction("stop") { () async in
      await self.engine.stop()
    }

    Function("setMuted") { (muted: Bool) in
      self.engine.setMuted(muted)
    }

    AsyncFunction("finalize") { () async throws -> [String: Any] in
      let text = try await self.engine.finalize()
      return ["text": text]
    }

    AsyncFunction("speak") { (id: String, text: String, seq: Int) async throws in
      try await self.engine.speak(id: id, text: text, seq: seq)
    }

    Function("duck") { (level: Double) in
      self.engine.duck(level)
    }

    Function("stopSpeech") { (fadeMs: Double, seq: Int) in
      self.engine.stopSpeech(fadeMs: fadeMs, seq: seq)
    }

    AsyncFunction("selfTest") { () async throws -> String in
      try await self.engine.selfTest()
    }
  }
}
