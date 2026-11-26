import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isHomeLaunchedThreadId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** What the voice session reads from Home: its messages and the threads it launched. */
export interface HomeView {
  readonly homeActive: boolean;
  readonly homeNeedsInput: boolean;
  /** Null while Home's thread detail is loading. */
  readonly messages: ReadonlyArray<HomeMessage> | null;
  readonly threads: ReadonlyArray<LaunchedThread>;
}

export interface HomeMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAtMs: number;
  readonly streaming: boolean;
}

export type LaunchedThreadState =
  | "needsInput"
  | "running"
  | "waiting"
  | "failed"
  | "finished"
  | "idle";

export interface LaunchedThread {
  readonly key: string;
  readonly title: string;
  readonly runId: string | null;
  readonly state: LaunchedThreadState;
  readonly finishedAtMs: number | null;
  /** The thread's latest assistant text, unsanitized. */
  readonly preview: string;
}

function launchedThreadState(shell: EnvironmentThreadShell): LaunchedThreadState {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "needsInput";
  if (threadRuntimeIsActive(shell.runtime)) {
    return shell.runtime?.status === "waiting" || shell.runtime?.status === "queued"
      ? "waiting"
      : "running";
  }
  if (shell.latestRun?.status === "failed") return "failed";
  if (shell.latestRun?.status === "completed") return "finished";
  return "idle";
}

function launchedThread(shell: EnvironmentThreadShell): LaunchedThread {
  const completedAt = shell.latestRun?.completedAt ?? null;
  const latest = shell.source.latestVisibleMessage;
  return {
    key: `${shell.environmentId}:${shell.id}`,
    title: shell.title,
    runId: shell.latestRun?.runId ?? null,
    state: launchedThreadState(shell),
    finishedAtMs: completedAt === null ? null : Date.parse(completedAt),
    preview: latest?.role === "assistant" ? latest.text : "",
  };
}

export function readHomeView(input: {
  readonly homeShell: EnvironmentThreadShell | null;
  readonly homeMessages: ReadonlyArray<OrchestrationV2ConversationMessage> | null;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
}): HomeView {
  return {
    homeActive: threadRuntimeIsActive(input.homeShell?.runtime),
    homeNeedsInput:
      input.homeShell?.hasPendingApprovals === true ||
      input.homeShell?.hasPendingUserInput === true,
    messages:
      input.homeMessages
        ?.filter((message) => message.notification === undefined)
        .map((message) => ({
          role: message.role,
          text: message.text,
          createdAtMs: DateTime.toEpochMillis(message.createdAt),
          streaming: message.streaming,
        })) ?? null,
    threads: input.shells
      .filter(
        (shell) =>
          isHomeLaunchedThreadId(shell.id) && shell.archivedAt === null && shell.deletedAt === null,
      )
      .map(launchedThread),
  };
}

const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s)]+/gi;
const THREAD_REF = /\b(?:thread|home(?:-launched)?|home-report):\S+/gi;
const UUID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
// Requires a digit so words that happen to be hex letters, like "defaced", survive.
const HEX_RUN = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi;
// Ids like task handles interleave letters and digits; names like laptop13 end in theirs.
const MIXED_ID = /\b(?=[a-z0-9]*\d[a-z]+\d)[a-z0-9]{7,}\b/gi;
const MARKDOWN_MARKS = /[`*_#>|]+/g;

/** One line the voice agent can read aloud: no ids, refs, links, hashes or markdown. */
export function speakable(text: string, maxLength: number): string {
  const clean = text
    .replace(MARKDOWN_LINK, "$1")
    .replace(URL, "")
    .replace(THREAD_REF, "")
    .replace(UUID, "")
    .replace(HEX_RUN, "")
    .replace(MIXED_ID, "")
    .replace(MARKDOWN_MARKS, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}
