import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  formatGithubOutput,
  isStableReleaseTag,
  parseGithubReleasesJson,
  planPublish,
  publishedTagsFromReleases,
  selectNewestStableTag,
  versionFromStableTag,
} from "./fork-stable-sync.ts";

const upstream = [
  { tag_name: "v0.1.7-nightly.20261102.4066", prerelease: true, draft: false },
  { tag_name: "v0.1.6", prerelease: false, draft: false },
  { tag_name: "v0.1.5", prerelease: false, draft: false },
] as const;

describe("fork-stable-sync", () => {
  it("accepts only plain vX.Y.Z tags as stable", () => {
    assert.isTrue(isStableReleaseTag("v0.1.6"));
    assert.isFalse(isStableReleaseTag("v0.1.6-nightly.20261031.3977"));
    assert.isFalse(isStableReleaseTag("v0.1.6-preview.1"));
    assert.isFalse(isStableReleaseTag("nightly-v0.1.6"));
    assert.equal(versionFromStableTag("v0.1.6"), "0.1.6");
  });

  it("picks the newest non-prerelease stable tag from a GitHub listing", () => {
    assert.equal(selectNewestStableTag(upstream), "v0.1.6");
    assert.equal(
      selectNewestStableTag([{ tag_name: "v0.1.7-nightly.1", prerelease: true, draft: false }]),
      undefined,
    );
  });

  it("skips a day when the fork already published that tag", () => {
    const plan = planPublish({
      upstreamReleases: upstream,
      forkTags: ["v0.1.6"],
    });
    assert.deepStrictEqual(plan, { _tag: "Skip", reason: "already-published", tag: "v0.1.6" });
    assert.equal(formatGithubOutput(plan), "decision=skip\nreason=already-published\ntag=v0.1.6");
  });

  it("builds the newest stable tag the fork has not published", () => {
    const plan = planPublish({
      upstreamReleases: upstream,
      forkTags: ["v0.1.5"],
    });
    assert.deepStrictEqual(plan, { _tag: "Build", tag: "v0.1.6", version: "0.1.6" });
    assert.equal(formatGithubOutput(plan), "decision=build\ntag=v0.1.6\nversion=0.1.6");
  });

  it("builds an explicit requested stable tag", () => {
    const plan = planPublish({
      upstreamReleases: upstream,
      forkTags: [],
      requestedTag: "v0.1.5",
    });
    assert.deepStrictEqual(plan, { _tag: "Build", tag: "v0.1.5", version: "0.1.5" });
  });

  it("skips a requested nightly tag instead of publishing it", () => {
    const plan = planPublish({
      upstreamReleases: upstream,
      forkTags: [],
      requestedTag: "v0.1.7-nightly.20261102.4066",
    });
    assert.deepStrictEqual(plan, {
      _tag: "Skip",
      reason: "no-stable",
      tag: "v0.1.7-nightly.20261102.4066",
    });
  });

  it("ignores draft fork releases when deciding if a tag is already published", () => {
    const tags = publishedTagsFromReleases([
      { tag_name: "v0.1.6", prerelease: false, draft: true },
      { tag_name: "v0.1.5", prerelease: false, draft: false },
    ]);
    assert.deepStrictEqual(tags, ["v0.1.5"]);
    const plan = planPublish({
      upstreamReleases: upstream,
      forkTags: tags,
    });
    assert.deepStrictEqual(plan, { _tag: "Build", tag: "v0.1.6", version: "0.1.6" });
  });

  it("CLI writes GITHUB_OUTPUT for a build plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-stable-sync-"));
    const upstreamPath = join(dir, "upstream.json");
    const forkPath = join(dir, "fork.json");
    const outputPath = join(dir, "github-output");
    writeFileSync(upstreamPath, JSON.stringify(upstream));
    writeFileSync(
      forkPath,
      JSON.stringify([{ tag_name: "v0.1.5", prerelease: false, draft: false }]),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "../fork-stable-sync.ts"),
        "--upstream",
        upstreamPath,
        "--fork",
        forkPath,
        "--github-output",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /decision=build/);
    assert.match(readFileSync(outputPath, "utf8"), /tag=v0\.1\.6/);
  });

  it("parses a GitHub releases JSON array and NDJSON", () => {
    const array = parseGithubReleasesJson(
      JSON.stringify([{ tag_name: "v0.1.6", prerelease: false, draft: false }]),
    );
    assert.deepStrictEqual(array, [{ tag_name: "v0.1.6", prerelease: false, draft: false }]);
    const ndjson = parseGithubReleasesJson(
      '{"tag_name":"v0.1.6","prerelease":false,"draft":false}\n{"tag_name":"v0.1.5","prerelease":true,"draft":false}\n',
    );
    assert.equal(ndjson.length, 2);
    assert.equal(ndjson[1]?.prerelease, true);
  });
});
