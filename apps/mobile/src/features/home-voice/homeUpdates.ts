import { speakable, type HomeView, type LaunchedThread } from "./homeView";

export const HOME_UPDATE = "[Home update]";

export type HomeUpdate =
  | { readonly kind: "reply"; readonly text: string; readonly alreadySpoken: ReadonlyArray<string> }
  | { readonly kind: "needsInput"; readonly title: string }
  | { readonly kind: "failed"; readonly title: string }
  | { readonly kind: "finished"; readonly title: string; readonly preview: string };

/** What a session has already reported; every update derives from it, so replays stay quiet. */
export interface HomeUpdateCursor {
  readonly startedAtMs: number;
  /** createdAt of the newest Home message already accounted for. */
  readonly homeCursor: number;
  /** One key per thread, run and attention state already reported or present at start. */
  readonly seenAttention: ReadonlySet<string>;
}

const REPLY_CHARS = 1_500;
const TITLE_CHARS = 80;
const PREVIEW_CHARS = 120;

type AttentionState = Extract<LaunchedThread["state"], "needsInput" | "failed" | "finished">;

function attentionState(thread: LaunchedThread): AttentionState | null {
  return thread.state === "needsInput" || thread.state === "failed" || thread.state === "finished"
    ? thread.state
    : null;
}

const attentionKey = (thread: LaunchedThread, state: AttentionState) =>
  `${state}:${thread.key}:${thread.runId ?? ""}`;

/** Baseline at session start: only what changes afterwards is reported. */
export function startHomeUpdateCursor(view: HomeView, nowMs: number): HomeUpdateCursor {
  const seenAttention = new Set<string>();
  for (const thread of view.threads) {
    const state = attentionState(thread);
    if (state !== null) seenAttention.add(attentionKey(thread, state));
  }
  const newest = view.messages?.reduce((max, message) => Math.max(max, message.createdAtMs), 0);
  return { startedAtMs: nowMs, homeCursor: newest ?? nowMs, seenAttention };
}

export function diffHomeUpdates(
  view: HomeView,
  cursor: HomeUpdateCursor,
): { readonly updates: ReadonlyArray<HomeUpdate>; readonly cursor: HomeUpdateCursor } {
  const updates: Array<HomeUpdate> = [];
  let homeCursor = cursor.homeCursor;
  const unseen = view.messages?.filter((message) => message.createdAtMs > homeCursor) ?? [];
  // A message still streaming may be the final reply; wait so Home's answer is sent once, whole.
  if (!view.homeActive && unseen.length > 0 && unseen.every((message) => !message.streaming)) {
    homeCursor = Math.max(...unseen.map((message) => message.createdAtMs));
    const reply = unseen.findLast(
      (message) => message.role === "assistant" && message.text.trim() !== "",
    );
    if (reply !== undefined) {
      updates.push({
        kind: "reply",
        text: speakable(reply.text, REPLY_CHARS),
        alreadySpoken: [],
      });
    }
  }

  const seenAttention = new Set(cursor.seenAttention);
  for (const thread of view.threads) {
    const state = attentionState(thread);
    if (state === null) continue;
    const key = attentionKey(thread, state);
    if (seenAttention.has(key)) continue;
    // A run that ended before the session started is old news that loaded late.
    if (
      state !== "needsInput" &&
      thread.finishedAtMs !== null &&
      thread.finishedAtMs < cursor.startedAtMs
    ) {
      continue;
    }
    seenAttention.add(key);
    const title = speakable(thread.title, TITLE_CHARS);
    updates.push(
      state === "finished"
        ? { kind: "finished", title, preview: speakable(thread.preview, PREVIEW_CHARS) }
        : { kind: state, title },
    );
  }

  return {
    updates,
    cursor:
      updates.length === 0 && homeCursor === cursor.homeCursor
        ? cursor
        : { ...cursor, homeCursor, seenAttention },
  };
}

export function renderHomeUpdate(update: HomeUpdate): string {
  switch (update.kind) {
    case "reply":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- sent to the voice agent, which matches this English
      return `[Home update] Home replied: ${update.text}`;
    case "needsInput":
      return `[Home update] "${update.title}" needs you.`;
    case "failed":
      return `[Home update] "${update.title}" failed.`;
    case "finished":
      return update.preview === ""
        ? `[Home update] "${update.title}" finished.`
        : `[Home update] "${update.title}" finished: ${update.preview}`;
  }
}
