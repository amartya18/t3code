import { speakable, type HomeView } from "./homeView";

/** The first message of a voice session: what Home and its threads are doing. */
export interface CatchUp {
  readonly homeStatus: string;
  /** Titles with a pending approval or question. */
  readonly needsAmar: ReadonlyArray<string>;
  readonly running: ReadonlyArray<string>;
  readonly waiting: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly recentlyFinished: ReadonlyArray<{ readonly title: string; readonly preview: string }>;
  readonly homeMessages: ReadonlyArray<string>;
}

const MAX_CHARS = 2_400;
const TITLE_CHARS = 80;
const PREVIEW_CHARS = 120;
const HOME_MESSAGE_CHARS = 300;
const MAX_FINISHED = 5;
const MAX_HOME_MESSAGES = 3;
const FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

export function buildCatchUp(view: HomeView, nowMs: number): CatchUp {
  const titlesIn = (state: HomeView["threads"][number]["state"]) =>
    view.threads
      .filter((thread) => thread.state === state)
      .map((thread) => speakable(thread.title, TITLE_CHARS));
  return {
    homeStatus: view.homeNeedsInput ? "waiting on you" : view.homeActive ? "working" : "idle",
    needsAmar: titlesIn("needsInput"),
    running: titlesIn("running"),
    waiting: titlesIn("waiting"),
    failed: titlesIn("failed"),
    recentlyFinished: view.threads
      .filter(
        (thread) =>
          thread.state === "finished" &&
          thread.finishedAtMs !== null &&
          nowMs - thread.finishedAtMs <= FINISHED_WINDOW_MS,
      )
      .sort((left, right) => (right.finishedAtMs ?? 0) - (left.finishedAtMs ?? 0))
      .slice(0, MAX_FINISHED)
      .map((thread) => ({
        title: speakable(thread.title, TITLE_CHARS),
        preview: speakable(thread.preview, PREVIEW_CHARS),
      })),
    homeMessages: (view.messages ?? [])
      .filter((message) => message.role === "assistant" && !message.streaming)
      .slice(-MAX_HOME_MESSAGES)
      .map((message) => speakable(message.text, HOME_MESSAGE_CHARS))
      .filter((text) => text !== ""),
  };
}

const quoted = (titles: ReadonlyArray<string>) => titles.map((title) => `"${title}"`).join(", ");

/** Most urgent first, so the cap only ever cuts the least useful lines. */
export function renderCatchUp(catchUp: CatchUp): string {
  const needsYou = [
    ...catchUp.failed.map((title) => `"${title}" failed`),
    ...catchUp.needsAmar.map((title) => `"${title}" has a question or approval`),
  ];
  const lines = [
    `[Catch-up] Home is ${catchUp.homeStatus}.`,
    needsYou.length > 0 ? `Needs you: ${needsYou.join("; ")}.` : "Nothing needs you.",
    catchUp.running.length > 0 ? `Running: ${quoted(catchUp.running)}.` : null,
    catchUp.waiting.length > 0 ? `Waiting: ${quoted(catchUp.waiting)}.` : null,
    ...catchUp.recentlyFinished.map(({ title, preview }) =>
      preview === "" ? `Finished: "${title}".` : `Finished: "${title}": ${preview}`,
    ),
    ...catchUp.homeMessages.map((text) => `Home said: ${text}`),
  ];
  let output = "";
  for (const line of lines) {
    if (line === null) continue;
    const next = output === "" ? line : `${output}\n${line}`;
    if (next.length > MAX_CHARS) {
      const room = MAX_CHARS - output.length - 2;
      return room > 20 ? `${output}\n${line.slice(0, room).trimEnd()}…` : output;
    }
    output = next;
  }
  return output;
}
