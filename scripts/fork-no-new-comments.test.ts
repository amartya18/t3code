// @effect-diagnostics nodeBuiltinImport:off - builds real git repos on disk to drive the CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";

const SCRIPT = NodePath.join(import.meta.dirname, "fork-no-new-comments.ts");

type Files = Record<string, ReadonlyArray<string>>;

function repo() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-no-new-comments-"));
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (files: Files) => {
    for (const [file, lines] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), `${lines.join("\n")}\n`);
    }
  };
  const stage = (files: Files) => {
    write(files);
    git("add", "-A");
  };
  const commit = (files: Files) => {
    stage(files);
    git("commit", "-q", "--allow-empty", "-m", "change");
  };
  const check = (...args: Array<string>) => {
    const result = NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  commit({ "src/app.ts": ["export const a = 1;"] });
  return { git, write, stage, commit, check };
}

it("flags each new comment in the staged diff with its file and line", () => {
  const { stage, check } = repo();
  stage({
    "src/app.ts": [
      "export const a = 1;",
      "// explains b",
      "export const b = 2;",
      "/*",
      "  block body",
      "*/",
      "export const c = 3;",
    ],
    "deploy.yml": ["# set up", "on: push"],
    "query.sql": ["-- pick rows", "select 1;"],
  });

  const { status, output } = check();

  expect(status).toBe(1);
  expect(output).toContain("New code comments (4)");
  expect(output).toContain("src/app.ts:2  // explains b");
  expect(output).toContain("src/app.ts:4  /*  (+2 lines)");
  expect(output).toContain("deploy.yml:1  # set up");
  expect(output).toContain("query.sql:1  -- pick rows");
  expect(output).toContain("This fork takes no new code comments.");
  expect(output).toContain("start the comment\nwith `keep:`");
});

it("allows suppressions with a reason, licences, shebangs, markers, keeps, and contracts export docs", () => {
  const { commit, stage, check } = repo();
  commit({ "packages/contracts/src/thing.ts": ["export const thing = 1;"] });
  stage({
    "src/allowed.ts": [
      "#!/usr/bin/env node",
      "// SPDX-License-Identifier: MIT",
      "// oxlint-disable-next-line no-console -- prints the report",
      "// @ts-expect-error the upstream types miss this overload",
      "// regression: #123",
      "// keep: Chromium drops the first frame after a resize,",
      "// so the first paint waits one frame.",
      "export const a = 1;",
    ],
    "packages/contracts/src/thing.ts": [
      "/**",
      " * What a thing is.",
      " */",
      "export const thing = 1;",
    ],
  });

  expect(check()).toEqual({ status: 0, output: "" });
});

it("flags near-misses of the allowlist", () => {
  const { stage, check } = repo();
  stage({
    "src/near.ts": [
      "// @ts-ignore",
      "export const a = 1;",
      "// oxlint-disable-next-line no-console",
      "export const b = 2;",
      "// regression: fixed it",
      "export const c = 3;",
    ],
    "packages/contracts/src/internal.ts": [
      "/** Not exported. */",
      "const hidden = 1;",
      "export const shown = hidden;",
    ],
  });

  const { status, output } = check();

  expect(status).toBe(1);
  expect(output).toContain("New code comments (4)");
  expect(output).toContain("src/near.ts:1");
  expect(output).toContain("src/near.ts:3");
  expect(output).toContain("src/near.ts:5");
  expect(output).toContain("packages/contracts/src/internal.ts:1");
});

it("allows only suppressions and issue markers in test files", () => {
  const { stage, check } = repo();
  stage({
    "src/app.test.ts": [
      "// oxlint-disable-next-line no-console -- prints the report",
      "// regression: #123",
      "it('works', () => {});",
      "// keep: the timer needs a real clock",
      "it('waits', () => {});",
      "// SPDX-License-Identifier: MIT",
    ],
    "packages/contracts/src/thing.test.ts": ["/** A doc. */", "export const thing = 1;"],
  });

  const { status, output } = check();

  expect(status).toBe(1);
  expect(output).toContain("New code comments (3)");
  expect(output).toContain("src/app.test.ts:4");
  expect(output).toContain("src/app.test.ts:6");
  expect(output).toContain("packages/contracts/src/thing.test.ts:1");
});

it("skips generated, vendored, and non-code files", () => {
  const { commit, stage, check } = repo();
  commit({ ".gitattributes": ["gen/** linguist-generated", "third/** linguist-vendored"] });
  stage({
    "gen/api.ts": ["// generated", "export {};"],
    "third/lib.ts": ["// vendored", "export {};"],
    ".repos/effect/index.ts": ["// reference copy", "export {};"],
    "src/routeTree.gen.ts": ["// route tree", "export {};"],
    "README.md": ["<!-- note -->", "# Heading"],
    "src/real.ts": ["// counted", "export {};"],
  });

  const { status, output } = check();

  expect(status).toBe(1);
  expect(output).toContain("New code comments (1)");
  expect(output).toContain("src/real.ts:1");
});

it("passes while a merge is in progress and checks the same index once the merge is gone", () => {
  const { git, commit, check } = repo();
  git("checkout", "-q", "-b", "upstream");
  commit({ "src/upstream.ts": ["// upstream explains itself", "export {};"] });
  git("checkout", "-q", "main");
  commit({ "src/fork.ts": ["export {};"] });
  git("merge", "-q", "--no-ff", "--no-commit", "upstream");

  expect(check()).toEqual({ status: 0, output: "" });

  git("merge", "--quit");
  expect(check().status).toBe(1);
});

it("checks only the lines a commit range adds", () => {
  const { git, commit, check } = repo();
  commit({ "src/app.ts": ["// existing comment", "export const a = 1;"] });
  git("checkout", "-q", "-b", "feature");
  commit({ "src/app.ts": ["// existing comment", "export const a = 2;", "// new comment"] });

  const { status, output } = check("main...feature");

  expect(status).toBe(1);
  expect(output).toContain("New code comments (1)");
  expect(output).toContain("src/app.ts:3  // new comment");
});

it("counts untracked files when comparing a ref to the working tree", () => {
  const { write, check } = repo();
  write({ "src/new.ts": ["// untracked note", "export {};"] });

  expect(check().status).toBe(0);
  const { status, output } = check("HEAD");
  expect(status).toBe(1);
  expect(output).toContain("src/new.ts:1  // untracked note");
});
