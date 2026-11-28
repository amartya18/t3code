import { describe, expect, it } from "vite-plus/test";

import withVoiceCallControl from "./withVoiceCallControl.cjs";

const { addVoiceCallControl } = withVoiceCallControl;

// The index.swift expo-widgets 58.0.29 generates for this app's two widgets.
const INDEX_SWIFT = `import WidgetKit
import SwiftUI
internal import ExpoWidgets

@main
struct ExportWidgets0: WidgetBundle {
  var body: some Widget {
    if #available(iOS 17.0, *) {
      SubscriptionUsage()
    }
    AgentActivity()
    WidgetLiveActivity()
  }
}`;

describe("addVoiceCallControl", () => {
  const swift = addVoiceCallControl(INDEX_SWIFT, "t3code-dev");

  it("registers the control in the widget bundle on iOS 18", () => {
    expect(swift).toContain(
      "  var body: some Widget {\n    if #available(iOS 18.0, *) {\n      StartVoiceCallControl()\n    }\n    if #available(iOS 17.0, *) {",
    );
    expect(swift).toContain("struct StartVoiceCallControl: ControlWidget {");
    expect(swift).toContain("import SwiftUI\nimport AppIntents\n");
  });

  it("opens the running variant's voice link", () => {
    expect(swift).toContain('OpenURLIntent(URL(string: "t3code-dev://voice")!)');
  });

  it("runs once per generated file", () => {
    expect(addVoiceCallControl(swift, "t3code-dev")).toBe(swift);
  });

  it("fails the prebuild when expo-widgets changes the bundle's shape", () => {
    expect(() =>
      addVoiceCallControl(INDEX_SWIFT.replace("ExportWidgets0", "Widgets"), "t3code"),
    ).toThrow(/changed shape/);
  });
});
