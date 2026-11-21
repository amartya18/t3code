// @effect-diagnostics globalTimers:off globalDate:off -- The sandboxed overlay page has no Effect runtime.
import { ipcRenderer } from "electron";

import { MARK_MODE_OVERLAY_CHANNEL, type MainToOverlay, type OverlayToMain } from "./channels.ts";

type Point = { readonly x: number; readonly y: number };

const send = (message: OverlayToMain) => ipcRenderer.send(MARK_MODE_OVERLAY_CHANNEL, message);
// Wall clock, like the audio start: a long-lived renderer's performance clock falls behind after sleep.
const epochAt = (timeStamp: number) => Date.now() - (performance.now() - timeStamp);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("ink") as HTMLCanvasElement;
  const context = canvas.getContext("2d");
  if (!context) return;
  const toolbar = document.getElementById("toolbar");
  const elapsed = document.getElementById("elapsed");
  const marks = document.getElementById("marks");
  const { inkColor = "#FF3B30", inkWidth = "4", startedAt = "0" } = document.body.dataset;

  let drawn: Point[][] = [];
  let active: { pointerId: number; points: Point[]; startedAt: number } | null = null;
  let capturing = false;

  // Quadratic curves through segment midpoints keep the line smooth without lagging the pointer.
  const drawSegment = (points: readonly Point[], index: number) => {
    const current = points[index]!;
    if (index === 0) {
      context.beginPath();
      context.arc(current.x, current.y, Number(inkWidth) / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    const previous = points[index - 1]!;
    context.beginPath();
    const from = index === 1 ? previous : mid(points[index - 2]!, previous);
    const to = mid(previous, current);
    context.moveTo(from.x, from.y);
    context.quadraticCurveTo(previous.x, previous.y, to.x, to.y);
    context.stroke();
  };
  const drawTail = (points: readonly Point[]) => {
    if (points.length < 2) return;
    const last = points.at(-1)!;
    const from = mid(points.at(-2)!, last);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(last.x, last.y);
    context.stroke();
  };
  const redraw = () => {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const points of active ? [...drawn, active.points] : drawn) {
      points.forEach((_, index) => drawSegment(points, index));
      drawTail(points);
    }
  };
  const resize = () => {
    const ratio = window.devicePixelRatio;
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Number(inkWidth);
    context.strokeStyle = inkColor;
    context.fillStyle = inkColor;
    redraw();
  };
  resize();
  window.addEventListener("resize", resize);

  const endStroke = () => {
    if (!active) return;
    const { points, startedAt: strokeStartedAt } = active;
    active = null;
    if (!capturing) drawTail(points);
    drawn.push(points);
    send({ type: "stroke", stroke: { points, startedAt: strokeStartedAt, endedAt: Date.now() } });
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (active || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    active = {
      pointerId: event.pointerId,
      points: [{ x: event.clientX, y: event.clientY }],
      startedAt: epochAt(event.timeStamp),
    };
    // Ink drawn while the screen is captured is kept and shown once the capture is done.
    if (!capturing) drawSegment(active.points, 0);
    send({ type: "pen-down" });
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    for (const sample of event.getCoalescedEvents?.() ?? [event]) {
      active.points.push({ x: sample.clientX, y: sample.clientY });
      if (!capturing) drawSegment(active.points, active.points.length - 1);
    }
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    canvas.addEventListener(type, (event) => {
      if (active && event.pointerId === active.pointerId) endStroke();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      send({ type: "finish" });
    }
  });
  document.getElementById("done")?.addEventListener("click", () => send({ type: "finish" }));
  document.getElementById("discard")?.addEventListener("click", () => send({ type: "cancel" }));

  if (elapsed) {
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1_000));
      elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 1_000);
  }

  ipcRenderer.on(MARK_MODE_OVERLAY_CHANNEL, (_event, message: MainToOverlay) => {
    if (message.type === "capture") {
      capturing = true;
      drawn = [];
      redraw();
      if (toolbar) toolbar.hidden = true;
      // Two frames: the first commits the cleared canvas, the second runs after it was presented.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => send({ type: "capture-ready", id: message.id })),
      );
    } else if (message.type === "captured") {
      capturing = false;
      redraw();
      if (toolbar) toolbar.hidden = false;
    } else if (marks) {
      marks.textContent = message.label;
    }
  });
});
