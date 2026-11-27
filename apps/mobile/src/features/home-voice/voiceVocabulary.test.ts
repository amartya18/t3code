import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { voiceVocabulary } from "./voiceVocabulary";

const HERE = EnvironmentId.make("laptop13");
const ELSEWHERE = EnvironmentId.make("mac");

const project = (title: string, environmentId = HERE) => ({ environmentId, title });

const thread = (
  title: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly updatedAt?: string;
    readonly archivedAt?: string | null;
    readonly deletedAt?: string | null;
  } = {},
) => ({
  environmentId: options.environmentId ?? HERE,
  title,
  updatedAt: options.updatedAt ?? "2026-11-27T10:00:00.000Z",
  archivedAt: options.archivedAt ?? null,
  deletedAt: options.deletedAt ?? null,
});

describe("voiceVocabulary", () => {
  it("starts with the fixed words, then this environment's projects and live thread titles", () => {
    const words = voiceVocabulary({
      environmentId: HERE,
      projects: [project("t3code"), project("court-booking-bot"), project("dotfiles", ELSEWHERE)],
      threads: [
        thread("Custom Mode research"),
        thread("Old idea", { archivedAt: "2026-11-20T00:00:00.000Z" }),
        thread("Gone", { deletedAt: "2026-11-20T00:00:00.000Z" }),
        thread("Mac only", { environmentId: ELSEWHERE }),
      ],
    });

    expect(words.slice(0, 3)).toEqual(["T3", "T3 Code", "Home"]);
    expect(words).toContain("poteto-mode");
    expect(words).toContain("Amar");
    expect(words).not.toContain("Parakeet");
    expect(words.slice(-3)).toEqual(["t3code", "court-booking-bot", "Custom Mode research"]);
    for (const absent of ["dotfiles", "Old idea", "Gone", "Mac only"]) {
      expect(words).not.toContain(absent);
    }
  });

  it("lists each name once, whatever its case or spacing", () => {
    const words = voiceVocabulary({
      environmentId: HERE,
      projects: [project("Home"), project(" Telegram "), project("wiki")],
      threads: [thread("WIKI"), thread("telegram"), thread("  ")],
    });

    expect(words.filter((word) => word.toLowerCase() === "wiki")).toEqual(["wiki"]);
    expect(words.filter((word) => word.toLowerCase() === "telegram")).toEqual(["Telegram"]);
    expect(words.filter((word) => word.toLowerCase() === "home")).toEqual(["Home"]);
    expect(words).not.toContain("");
  });

  it("caps the list at 200, keeping the most recently updated threads", () => {
    const threads = Array.from({ length: 300 }, (_, index) =>
      thread(`Thread ${index}`, {
        updatedAt: new Date(Date.UTC(2026, 10, 1) + index * 60_000).toISOString(),
      }),
    );
    const words = voiceVocabulary({ environmentId: HERE, projects: [], threads });

    expect(words).toHaveLength(200);
    expect(words).toContain("Thread 299");
    expect(words).not.toContain("Thread 0");
  });
});
