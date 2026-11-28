import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { PortalContainer } from "~/components/ui/portal-container";
import { useActivePreviewSessions } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import { PreviewView } from "./PreviewView";
import { usePreviewWindowStore } from "./previewWindows";

function PreviewWindowBar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
}) {
  const { threadRef, tabId, runtimeTabId } = props;
  const entry = usePreviewWindowStore((state) => state.windows[runtimeTabId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a window this renderer has no popup for, as after a reload, would have no bar, so the tab comes back to the panel
  useEffect(() => {
    if (!entry) void previewBridge?.window.close(runtimeTabId).catch(() => undefined);
  }, [entry, runtimeTabId]);
  if (!entry) return null;
  return createPortal(
    <PortalContainer value={entry.overlays}>
      <PreviewView threadRef={threadRef} tabId={tabId} visible chromeOnly />
    </PortalContainer>,
    entry.root,
  );
}

export function PreviewWindowBars() {
  const previewByThreadKey = useActivePreviewSessions();
  return Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) return [];
    return Object.entries(previewState.desktopByTabId)
      .filter(([, desktop]) => desktop.inWindow)
      .map(([tabId]) => {
        const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
        return (
          <PreviewWindowBar
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={tabId}
            runtimeTabId={runtimeTabId}
          />
        );
      });
  });
}
