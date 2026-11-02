#!/usr/bin/env node

import * as fs from "node:fs";

import {
  formatGithubOutput,
  parseGithubReleasesJson,
  planPublish,
  publishedTagsFromReleases,
} from "./lib/fork-stable-sync.ts";

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const upstreamPath = readFlag(argv, "upstream");
  const forkPath = readFlag(argv, "fork");
  if (upstreamPath === undefined || forkPath === undefined) {
    console.error(
      "usage: fork-stable-sync.ts --upstream <releases.json> --fork <releases.json> [--requested <tag>] [--github-output]",
    );
    process.exit(2);
  }

  const plan = planPublish({
    upstreamReleases: parseGithubReleasesJson(fs.readFileSync(upstreamPath, "utf8")),
    forkTags: publishedTagsFromReleases(parseGithubReleasesJson(fs.readFileSync(forkPath, "utf8"))),
    requestedTag: readFlag(argv, "requested"),
  });
  const output = formatGithubOutput(plan);
  process.stdout.write(`${output}\n`);
  if (argv.includes("--github-output")) {
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput === undefined || githubOutput.trim().length === 0) {
      console.error("GITHUB_OUTPUT is not set");
      process.exit(2);
    }
    fs.appendFileSync(githubOutput, `${output}\n`);
  }
}
