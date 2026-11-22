import type { MarkModeStroke } from "@t3tools/contracts";

export const MARK_MODE_START_CHANNEL = "desktop:mark-mode-start";
export const MARK_MODE_FINISH_CHANNEL = "desktop:mark-mode-finish";
export const MARK_MODE_CANCEL_CHANNEL = "desktop:mark-mode-cancel";
export const MARK_MODE_SET_SHORTCUT_CHANNEL = "desktop:mark-mode-set-shortcut";
export const MARK_MODE_EVENT_CHANNEL = "desktop:mark-mode-event";
export const MARK_MODE_OVERLAY_CHANNEL = "desktop:mark-mode-overlay";

export type OverlayToMain =
  | { readonly type: "pen-down" }
  | { readonly type: "stroke"; readonly stroke: MarkModeStroke }
  /** The overlay painted a frame without ink or toolbar, so a capture sees the bare screen. */
  | { readonly type: "capture-ready"; readonly id: number }
  | { readonly type: "finish" }
  | { readonly type: "cancel" };

export type MainToOverlay =
  | { readonly type: "capture"; readonly id: number }
  | { readonly type: "captured" }
  | { readonly type: "marks"; readonly label: string };
