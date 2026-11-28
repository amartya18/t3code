"use strict";

// Precede expo-widgets so its reverse-ordered mods write index.swift before this extends it.
// Appending to index.swift keeps the control in sources the widget target already compiles.

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const TARGET_NAME = "ExpoWidgetsTarget";
const BUNDLE_BODY = "struct ExportWidgets0: WidgetBundle {\n  var body: some Widget {";

const controlSwift = (url) => `

@available(iOS 18.0, *)
struct StartVoiceCallControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "StartVoiceCall") {
      ControlWidgetButton(action: StartVoiceCallIntent()) {
        Label("Start voice call", systemImage: "waveform")
      }
    }
    .displayName("Start voice call")
    .description("Opens T3 Code in a voice call with Home.")
  }
}

// OpenURLIntent runs from the extension, so the app target needs no copy of this intent.
@available(iOS 18.0, *)
struct StartVoiceCallIntent: AppIntent {
  static let title: LocalizedStringResource = "Start voice call"

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(URL(string: ${JSON.stringify(url)})!))
  }
}
`;

/** @param {string} indexSwift @param {string} scheme */
function addVoiceCallControl(indexSwift, scheme) {
  if (indexSwift.includes("StartVoiceCallControl")) return indexSwift;
  if (!indexSwift.includes(BUNDLE_BODY) || !indexSwift.includes("import SwiftUI\n")) {
    throw new Error(
      "withVoiceCallControl: expo-widgets' index.swift changed shape; update the control splice.",
    );
  }
  return (
    indexSwift
      .replace("import SwiftUI\n", "import SwiftUI\nimport AppIntents\n")
      .replace(
        BUNDLE_BODY,
        `${BUNDLE_BODY}\n    if #available(iOS 18.0, *) {\n      StartVoiceCallControl()\n    }`,
      ) + controlSwift(`${scheme}://voice`)
  );
}

function withVoiceCallControl(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const scheme = Array.isArray(cfg.scheme) ? cfg.scheme[0] : cfg.scheme;
      if (!scheme) throw new Error("withVoiceCallControl: the app needs a URL scheme.");
      const indexPath = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME, "index.swift");
      fs.writeFileSync(indexPath, addVoiceCallControl(fs.readFileSync(indexPath, "utf8"), scheme));
      return cfg;
    },
  ]);
}

module.exports = Object.assign(withVoiceCallControl, { addVoiceCallControl });
