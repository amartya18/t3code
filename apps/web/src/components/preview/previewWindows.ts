import { desktopPreviewWindowName } from "@t3tools/contracts";
import { create } from "zustand";

import {
  type PreviewWindowDocument,
  preparePreviewWindowDocument,
} from "~/browser/previewWindowDocument";

import { previewBridge } from "./previewBridge";

export interface PreviewWindow extends PreviewWindowDocument {
  readonly popup: Window;
}

export const usePreviewWindowStore = create<{
  readonly windows: Readonly<Record<string, PreviewWindow>>;
}>(() => ({ windows: {} }));

function forget(runtimeTabId: string, entry: PreviewWindow): void {
  entry.dispose();
  usePreviewWindowStore.setState(({ windows }) => {
    if (windows[runtimeTabId] !== entry) return {};
    const { [runtimeTabId]: _removed, ...rest } = windows;
    return { windows: rest };
  });
}

/**
 * Moves the tab into its own window, or focuses the one it is in. The desktop hosts the popup
 * above the page; false when it refused, as for a tab that is recording.
 */
export function openPreviewWindow(runtimeTabId: string): boolean {
  if (!previewBridge) return false;
  const bridge = previewBridge;
  const existing = usePreviewWindowStore.getState().windows[runtimeTabId];
  if (existing && !existing.popup.closed) {
    void bridge.window.focus(runtimeTabId).catch(() => undefined);
    return true;
  }
  if (existing) forget(runtimeTabId, existing);
  const popup = window.open("about:blank", desktopPreviewWindowName(runtimeTabId));
  if (!popup) return false;
  const entry: PreviewWindow = {
    popup,
    ...preparePreviewWindowDocument(popup.document, document, (open) => {
      void bridge.window.setOverlay(runtimeTabId, open).catch(() => undefined);
    }),
  };
  // The desktop closes the popup's page whenever the tab leaves its window.
  popup.addEventListener("pagehide", () => forget(runtimeTabId, entry), { once: true });
  usePreviewWindowStore.setState(({ windows }) => ({
    windows: { ...windows, [runtimeTabId]: entry },
  }));
  return true;
}
