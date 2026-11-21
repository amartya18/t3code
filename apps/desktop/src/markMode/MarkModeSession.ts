// @effect-diagnostics globalTimers:off globalDate:off -- The pause deadline lives in main beside the overlay windows; renderer timers get throttled.
import {
  MARK_MODE_IMAGE_MAX_EDGE,
  MarkModeStroke,
  type DesktopMarkModeEvent,
  type MarkModeMark,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import { MARK_MODE_OVERLAY_CHANNEL, type MainToOverlay, type OverlayToMain } from "./channels.ts";
import {
  initialGroupingState,
  stepGrouping,
  type GroupingEvent,
  type GroupingState,
  type MarkGroup,
} from "./MarkModeGrouping.ts";
import { overlayHtml, type OverlayToolbarText } from "./overlayHtml.ts";

const CAPTURE_READY_TIMEOUT_MS = 1_000;

const OverlayMessage: Schema.Codec<OverlayToMain> = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pen-down") }),
  Schema.Struct({ type: Schema.Literal("stroke"), stroke: MarkModeStroke }),
  Schema.Struct({ type: Schema.Literal("capture-ready"), id: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("finish") }),
  Schema.Struct({ type: Schema.Literal("cancel") }),
]);
const decodeOverlayMessage = Schema.decodeUnknownOption(OverlayMessage);

export type MarkModeSessionEnd = Extract<DesktopMarkModeEvent, { type: "finished" | "cancelled" }>;

export interface MarkModeSessionOptions {
  readonly pauseMs: number;
  readonly preloadPath: string;
  readonly platform: NodeJS.Platform;
  readonly toolbar: Omit<OverlayToolbarText, "marks">;
  readonly marksLabel: (count: number) => string;
  readonly onEnd: (event: MarkModeSessionEnd) => void;
  readonly onCaptureError: (cause: unknown) => void;
}

interface Overlay {
  readonly window: Electron.BrowserWindow;
  readonly display: Electron.Display;
  /** Position in `screen.getAllDisplays()`, the fallback when sources carry no display id. */
  readonly order: number;
}

/** Fits a display's pixels within the long-edge cap, never upscaling. */
function captureSize(display: Pick<Electron.Display, "size" | "scaleFactor">) {
  const width = display.size.width * display.scaleFactor;
  const height = display.size.height * display.scaleFactor;
  const fit = Math.min(1, MARK_MODE_IMAGE_MAX_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * fit)),
    height: Math.max(1, Math.round(height * fit)),
  };
}

async function captureDisplay({ display, order }: Overlay): Promise<MarkModeMark["screenshot"]> {
  const sources = await Electron.desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: captureSize(display),
  });
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ??
    (sources.length === 1 ? sources[0] : sources[order]);
  if (!source || source.thumbnail.isEmpty()) throw new Error("No screen source for the display.");
  const size = source.thumbnail.getSize();
  return { dataUrl: source.thumbnail.toDataURL(), width: size.width, height: size.height };
}

/** One overlay per display from start until Done, Discard, Enter, Escape or the shortcut. */
export class MarkModeSession {
  private readonly overlays = new Map<number, Overlay>();
  private readonly primaryDisplayId = Electron.screen.getPrimaryDisplay().id;
  private readonly marks: MarkModeMark[] = [];
  private readonly captureReady = new Map<number, () => void>();
  private grouping: GroupingState = initialGroupingState;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private captures: Promise<void> = Promise.resolve();
  private nextCaptureId = 0;
  private phase: "active" | "finishing" | "ended" = "active";

  private readonly options: MarkModeSessionOptions;

  constructor(options: MarkModeSessionOptions) {
    this.options = options;
  }

  async open() {
    Electron.ipcMain.on(MARK_MODE_OVERLAY_CHANNEL, this.onOverlayMessage);
    const startedAt = Date.now();
    try {
      await Promise.all(
        Electron.screen.getAllDisplays().map((display, order) => {
          const window = this.createOverlayWindow(display);
          this.overlays.set(display.id, { window, display, order });
          const toolbar =
            display.id === this.primaryDisplayId
              ? { ...this.options.toolbar, marks: this.options.marksLabel(0) }
              : null;
          const html = overlayHtml({ startedAt, toolbar });
          return window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        }),
      );
    } catch (error) {
      this.close();
      throw error;
    }
    if (this.phase !== "active") return;
    const cursorDisplay = Electron.screen.getDisplayNearestPoint(
      Electron.screen.getCursorScreenPoint(),
    );
    for (const { window, display } of this.overlays.values()) {
      if (display.id === cursorDisplay.id) continue;
      window.showInactive();
      window.setBounds(display.bounds);
    }
    const focused = this.overlays.get(cursorDisplay.id);
    if (focused) {
      focused.window.show();
      focused.window.setBounds(focused.display.bounds);
      focused.window.focus();
    }
  }

  async finish() {
    if (this.phase !== "active") return;
    this.phase = "finishing";
    this.step({ type: "flush" });
    await this.captures;
    if (this.phase !== "finishing") return;
    this.end({ type: "finished", marks: this.marks });
  }

  cancel() {
    if (this.phase === "ended") return;
    this.end({ type: "cancelled" });
  }

  private createOverlayWindow(display: Electron.Display) {
    const { platform } = this.options;
    const window = new Electron.BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      title: this.options.toolbar.label,
      // A non-activating panel floats over full-screen apps and Spaces without raising T3 Code.
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        zoomFactor: 1,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Not a guarantee on macOS 15 ScreenCaptureKit; clearing ink before each capture is.
    if (platform === "darwin" || platform === "win32") window.setContentProtection(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("closed", () => void this.finish());
    return window;
  }

  private readonly onOverlayMessage = (event: Electron.IpcMainEvent, raw: unknown) => {
    const overlay = [...this.overlays.values()].find(
      ({ window }) =>
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame,
    );
    const message = decodeOverlayMessage(raw);
    if (!overlay || Option.isNone(message)) return;
    const displayId = overlay.display.id;
    switch (message.value.type) {
      case "pen-down":
        if (this.phase === "active") this.step({ type: "pen-down", displayId });
        return;
      case "stroke":
        if (this.phase === "active") {
          this.step({ type: "stroke", displayId, stroke: message.value.stroke, now: Date.now() });
        }
        return;
      case "capture-ready":
        this.captureReady.get(message.value.id)?.();
        return;
      case "finish":
        void this.finish();
        return;
      case "cancel":
        this.cancel();
        return;
    }
  };

  private step(event: GroupingEvent) {
    const { state, closed } = stepGrouping(this.grouping, event, this.options.pauseMs);
    this.grouping = state;
    for (const group of closed) {
      this.captures = this.captures.then(() => this.capture(group));
    }
    clearTimeout(this.deadline);
    if (state.phase === "pausing") {
      this.deadline = setTimeout(
        () => this.step({ type: "deadline", now: Date.now() }),
        Math.max(0, state.deadline - Date.now()),
      );
    }
  }

  private async capture(group: MarkGroup) {
    const overlay = this.overlays.get(group.displayId);
    const firstStroke = group.strokes[0];
    if (!overlay || !firstStroke || this.phase === "ended") return;
    await this.clearOverlay(overlay);
    try {
      const screenshot = await captureDisplay(overlay);
      this.marks.push({
        index: this.marks.length + 1,
        startedAt: firstStroke.startedAt,
        display: { width: overlay.display.size.width, height: overlay.display.size.height },
        strokes: group.strokes,
        screenshot,
      });
    } catch (cause) {
      this.options.onCaptureError(cause);
    }
    if (this.ended()) return;
    this.send(overlay, { type: "captured" });
    const primary = this.overlays.get(this.primaryDisplayId);
    if (primary)
      this.send(primary, { type: "marks", label: this.options.marksLabel(this.marks.length) });
  }

  /** Resolves once the overlay painted a frame without ink or toolbar, or after a timeout. */
  private clearOverlay(overlay: Overlay) {
    if (overlay.window.isDestroyed()) return Promise.resolve();
    const id = ++this.nextCaptureId;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(done, CAPTURE_READY_TIMEOUT_MS);
      function done() {
        clearTimeout(timeout);
        resolve();
      }
      this.captureReady.set(id, done);
      this.send(overlay, { type: "capture", id });
    }).finally(() => this.captureReady.delete(id));
  }

  // A method, so TypeScript does not narrow the phase across awaits.
  private ended() {
    return this.phase === "ended";
  }

  private send({ window }: Overlay, message: MainToOverlay) {
    if (!window.isDestroyed()) window.webContents.send(MARK_MODE_OVERLAY_CHANNEL, message);
  }

  private end(event: MarkModeSessionEnd) {
    this.close();
    this.options.onEnd(event);
  }

  private close() {
    this.phase = "ended";
    clearTimeout(this.deadline);
    for (const resolve of this.captureReady.values()) resolve();
    Electron.ipcMain.removeListener(MARK_MODE_OVERLAY_CHANNEL, this.onOverlayMessage);
    for (const { window } of this.overlays.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
  }
}
