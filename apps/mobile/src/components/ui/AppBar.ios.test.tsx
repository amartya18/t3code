import { act, createContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));

// React Navigation merges each setOptions call into the screen's options.
vi.mock("@react-navigation/native", async () => {
  const { createContext } = await vi.importActual<typeof import("react")>("react");
  const navigation = {
    setOptions: (options: Record<string, unknown>) => {
      harness.options = { ...harness.options, ...options };
    },
    getState: () => undefined,
    canGoBack: () => true,
    addListener: () => () => {},
  };
  return {
    NavigationContext: createContext(navigation),
    NavigationRouteContext: createContext({ key: "editor", name: "SettingsScheduledTaskEdit" }),
  };
});
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("./Toolbar", () => ({ Toolbar: () => null }));
vi.mock("./AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("./nativeHeaderMenu.ios", () => ({ createNativeHeaderMenu: () => null }));
vi.mock("./ScreenHeaderButton", () => ({ ScreenHeaderButton: () => null }));
vi.mock("./useControlTheme", () => ({ useControlTheme: () => ({ colors: {} }) }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => false,
}));
vi.mock("../../features/layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../../features/layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../features/layout/inspector-bar-store", () => ({
  InspectorCloseContext: createContext(null),
}));
vi.mock("../../features/layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: false,
  createNativeMailSearchToolbarItem: () => null,
}));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { AppBar } from "./AppBar";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.options = {};
  vi.unstubAllGlobals();
});

function renderEditorBar(guardBack: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root ??= createRoot(document.createElement("div"));
  act(() =>
    root!.render(<AppBar title="Edit scheduled task" onBack={() => {}} guardBack={guardBack} />),
  );
}

it("lets swipe and native Back leave again once unsaved changes are undone", () => {
  renderEditorBar(false);
  renderEditorBar(true);
  expect(harness.options.gestureEnabled).toBe(false);

  renderEditorBar(false);
  // The iOS stack prevents native dismissal while gestureEnabled is false.
  expect(harness.options.gestureEnabled).not.toBe(false);
  expect(harness.options.headerBackVisible).toBe(true);
});
