import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { resolveExistingSnapShotTarget } from "../components/desktop/SnapShotCoordinator";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useStableCallback } from "../hooks/useStableCallback";
import { effectiveShortcutsForCommand } from "../keybindings";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  getMarkModeBridge,
  handleMarkModeEvent,
  setMarkModeTargetResolver,
} from "./markModeSession";

/** Fork-only: routes the desktop's Mark Mode events and fills the draft on screen. */
export function MarkModeCoordinator() {
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  } = useHandleNewThread();
  const resolveTarget = useStableCallback(async () => {
    const current = routeThreadRef ?? routeDraftId;
    const existing = current ? resolveExistingSnapShotTarget(current, routeThreadRef) : null;
    if (existing) return existing;
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    return projectRef ? ((await handleNewThread(projectRef))?.draftId ?? null) : null;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Mark Mode events from the desktop bridge
  useEffect(() => {
    const bridge = getMarkModeBridge();
    if (!bridge) return;
    const clearResolver = setMarkModeTargetResolver(resolveTarget);
    const unsubscribe = bridge.onEvent(handleMarkModeEvent);
    return () => {
      unsubscribe();
      clearResolver();
    };
  }, [resolveTarget]);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the binding system-wide in the desktop main process
  useEffect(() => {
    const [shortcut = null] = effectiveShortcutsForCommand(keybindings, "markMode.toggle");
    void getMarkModeBridge()?.setShortcut(shortcut);
  }, [keybindings]);

  return null;
}
