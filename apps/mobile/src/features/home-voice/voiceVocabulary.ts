import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

const VOICE_WORDS = [
  "T3",
  "T3 Code",
  "Home",
  "Claude",
  "Opus",
  "Sonnet",
  "Haiku",
  "Fable",
  "Grok",
  "poteto-mode",
  "pstack",
  "deslop",
  "Comment Sicko",
  "Cloudflare",
  "Workers",
  "R2",
  "Tailscale",
  "Expo",
  "EAS",
  "TestFlight",
  "Metro",
  "React Native",
  "Electron",
  "APNs",
  "Live Activity",
  "GitHub",
  "Telegram",
  "laptop13",
  "fork",
  "nightly",
  "worktree",
  "PR",
  "Mark Mode",
  "wiki",
  "Amar",
];

const MAX_WORDS = 200;

export function voiceVocabulary(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "title">>;
  readonly threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "title" | "updatedAt" | "archivedAt" | "deletedAt"
    >
  >;
}): ReadonlyArray<string> {
  const projects = input.projects
    .filter((project) => project.environmentId === input.environmentId)
    .map((project) => project.title);
  const threads = input.threads
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.archivedAt === null &&
        thread.deletedAt === null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => thread.title);
  const words = new Map<string, string>();
  for (const candidate of [...VOICE_WORDS, ...projects, ...threads]) {
    const word = candidate.trim();
    const key = word.toLowerCase();
    if (word !== "" && !words.has(key)) words.set(key, word);
    if (words.size === MAX_WORDS) break;
  }
  return [...words.values()];
}
