import { MARK_MODE_INK } from "@t3tools/contracts";

export interface OverlayToolbarText {
  readonly label: string;
  readonly marks: string;
  readonly done: string;
  readonly discard: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** Scriptless page: the sandboxed preload draws and talks to main. */
export function overlayHtml(input: {
  readonly startedAt: number;
  readonly toolbar: OverlayToolbarText | null;
}) {
  const { toolbar } = input;
  const toolbarHtml = toolbar
    ? `<div id="toolbar" role="toolbar" aria-label="${escapeHtml(toolbar.label)}">
<span class="dot" aria-hidden="true"></span><span id="elapsed">0:00</span>
<span id="marks">${escapeHtml(toolbar.marks)}</span>
<button id="discard" type="button">${escapeHtml(toolbar.discard)}</button>
<button id="done" type="button">${escapeHtml(toolbar.done)}</button></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; user-select: none; }
#ink { position: fixed; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
#toolbar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 5px 5px 5px 14px; border-radius: 999px; background: rgba(28, 28, 30, 0.92); color: #fff; font: 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); white-space: nowrap; }
#toolbar[hidden] { display: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: ${MARK_MODE_INK.color}; }
#elapsed { font-variant-numeric: tabular-nums; }
#marks { opacity: 0.7; }
button { font: inherit; color: inherit; border: 0; border-radius: 999px; padding: 3px 12px; cursor: pointer; background: rgba(255, 255, 255, 0.14); }
button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 1px; }
#done { background: #fff; color: #1c1c1e; font-weight: 600; }
</style></head>
<body data-ink-color="${MARK_MODE_INK.color}" data-ink-width="${MARK_MODE_INK.width}" data-started-at="${input.startedAt}">
<canvas id="ink"></canvas>${toolbarHtml}</body></html>`;
}
