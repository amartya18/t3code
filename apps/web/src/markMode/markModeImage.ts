import { msg } from "gt-react";
import { MARK_MODE_IMAGE_MAX_EDGE, MARK_MODE_INK, type MarkModeMark } from "@t3tools/contracts";

import { m } from "../i18n/messages";

const BADGE_RADIUS_AT_MAX_EDGE = 14;

/** The screenshot with the mark's ink and a numbered badge drawn in, as a PNG. */
export async function flattenMark(mark: MarkModeMark): Promise<File> {
  const { width, height, dataUrl } = mark.screenshot;
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error(m(msg("Images can’t be drawn in this window.")));
  context.drawImage(image, 0, 0, width, height);

  const scaleX = width / mark.display.width;
  const scaleY = height / mark.display.height;
  context.strokeStyle = MARK_MODE_INK.color;
  context.fillStyle = MARK_MODE_INK.color;
  context.lineWidth = MARK_MODE_INK.width * scaleX;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const { points } of mark.strokes) {
    const [first, ...rest] = points;
    if (!first) continue;
    context.beginPath();
    context.moveTo(first.x * scaleX, first.y * scaleY);
    // A tap is one point; a zero-length segment draws it as a dot with round caps.
    for (const point of rest.length ? rest : [first])
      context.lineTo(point.x * scaleX, point.y * scaleY);
    context.stroke();
  }

  const anchor = mark.strokes[0]?.points[0];
  if (anchor) {
    const radius = Math.max(
      8,
      (BADGE_RADIUS_AT_MAX_EDGE * Math.max(width, height)) / MARK_MODE_IMAGE_MAX_EDGE,
    );
    const clamp = (value: number, max: number) =>
      Math.min(Math.max(value, radius), Math.max(radius, max - radius));
    const x = clamp(anchor.x * scaleX - radius * 1.5, width);
    const y = clamp(anchor.y * scaleY - radius * 1.5, height);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#FFFFFF";
    context.font = `bold ${Math.round(radius * 1.2)}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(mark.index), x, y);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new File([blob], `mark-${mark.index}.png`, { type: "image/png" });
}
