import {
  type MarkModeMark,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { randomUUID } from "../lib/utils";
import { flattenMark } from "./markModeImage";

export type MarkModeTarget = DraftId | ScopedThreadRef;

/** Appends the text and one image per mark to the draft; returns how many marks did not fit. */
export async function deliverMarkModeDraft(
  target: MarkModeTarget,
  text: string,
  marks: ReadonlyArray<MarkModeMark>,
): Promise<number> {
  const { compressImageToByteLimit, readFileAsDataUrl } = await import("../lib/imageCompression");
  const store = useComposerDraftStore.getState();
  const prompt = store.getComposerDraft(target)?.prompt.trimEnd() ?? "";
  store.setPrompt(target, prompt ? `${prompt}\n\n${text}` : text);

  const draft = store.getComposerDraft(target);
  const room =
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS - (draft?.images.length ?? 0) - (draft?.files.length ?? 0);
  const persisted = [...(draft?.persistedAttachments ?? [])];
  let attached = 0;
  for (const mark of marks.toSorted((a, b) => a.index - b.index).slice(0, Math.max(room, 0))) {
    const compressed = await compressImageToByteLimit(
      await flattenMark(mark),
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    );
    if (!compressed.ok) continue;
    const { file } = compressed;
    const dataUrl = await readFileAsDataUrl(file);
    const id = randomUUID();
    const added = store.addImage(target, {
      type: "image",
      id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
    });
    if (!added) continue;
    persisted.push({ id, name: file.name, mimeType: file.type, sizeBytes: file.size, dataUrl });
    attached++;
  }
  if (attached > 0) await store.syncPersistedAttachments(target, persisted);
  dispatchSnapShotComposerFocus();
  return marks.length - attached;
}
