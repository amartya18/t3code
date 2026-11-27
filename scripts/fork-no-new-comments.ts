// @effect-diagnostics nodeBuiltinImport:off - CI runs this with plain node before any install, so it cannot import effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

type Syntax = "slash" | "hash" | "sql";
type AddedLine = { file: string; line: number; text: string };
type CommentBlock = { file: string; line: number; lines: Array<string> };

const SYNTAX: ReadonlyArray<readonly [RegExp, Syntax]> = [
  [/\.(?:[cm]?[jt]sx?|swift|kts?|s?css)$/, "slash"],
  [/\.(?:ya?ml|sh|bash|py|toml)$|(?:^|\/)Dockerfile[^/]*$|^\.vite-hooks\/[^/]+$/, "hash"],
  [/\.sql$/, "sql"],
];
const COMMENT_START: Record<Syntax, RegExp> = {
  slash: /^(?:\/\/|\{?\/\*|\*(?:\s|\/|$))/,
  hash: /^#/,
  sql: /^--/,
};
const SKIPPED =
  /^(?:\.repos|infra\/task-cache\/vendor|apps\/mobile\/(?:ios|android)|apps\/mobile\/modules\/t3-highlights\/(?:Vendor|cpp\/generated|nitrogen\/generated)|(?:packages\/source-control-github|apps\/server)\/schema)\/|\.gen\.ts$|\.graphql\.ts$|^apps\/mobile\/uniwind-types\.d\.ts$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?|androidTest)\//;

const DIRECTIVE =
  /^#!|(?:oxlint|eslint)-disable(?:-next-line|-line)?\s+\S.*\s--\s+\S|@ts-expect-error\s+\S|@effect-diagnostics\s+\S.*\s--?\s+\S|^\/\/\/\s*<reference\s|shellcheck\s+disable=|swiftlint:disable/;
const ISSUE_MARKER = /^(?:regression|quarantine):\s*(?:(?:[\w.-]+\/[\w.-]+)?#\d|https?:\/\/)/;
const LICENCE = /SPDX-License-Identifier|@license|\bcopyright\b/i;
const KEEP = /^keep:\s*\S/;

const RULE = [
  "This fork takes no new code comments. Say it in code instead: a clearer name, a type,",
  "a test, or a smaller function. Then delete the comment.",
  "",
  "Allowed: lint and TypeScript suppressions with a reason (`-- why`), licence headers,",
  "shebangs, `regression:` or `quarantine:` followed by an issue, and doc blocks on exports",
  "in packages/contracts/src. Test files take only the suppressions and markers.",
  "",
  "For a real exception, such as a quirk of a system we don't control, start the comment",
  "with `keep:`, for example `// keep: Chromium drops the first frame after a resize`.",
  "Reviewers see every keep.",
].join("\n");

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

const textOf = (line: string) =>
  line
    .trim()
    .replace(/^(?:\/\/\/?|\{?\/\*\*?|\*\/?|#|--)\s*/, "")
    .trim();

const syntaxOf = (file: string) => SYNTAX.find(([pattern]) => pattern.test(file))?.[1];

function parseDiff(diff: string): Array<AddedLine> {
  const added: Array<AddedLine> = [];
  let file = "";
  let line = 0;
  let previous = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ") && previous.startsWith("--- ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "";
    } else if (raw.startsWith("@@ ")) {
      line = Number(/^@@ -\S+ \+(\d+)/.exec(raw)?.[1]);
    } else if (file && raw.startsWith("+")) {
      added.push({ file, line: line++, text: raw.slice(1) });
    }
    previous = raw;
  }
  return added;
}

function untrackedLines(): Array<AddedLine> {
  return git(["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter((file) => file && syntaxOf(file))
    .flatMap((file) =>
      NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .map((text, index) => ({ file, line: index + 1, text })),
    );
}

function generatedFiles(files: ReadonlyArray<string>): Set<string> {
  if (files.length === 0) return new Set();
  const fields = git([
    "check-attr",
    "-z",
    "linguist-generated",
    "linguist-vendored",
    "--",
    ...files,
  ]).split("\0");
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === "set" || fields[index + 2] === "true") generated.add(fields[index]!);
  }
  return generated;
}

function commentBlocks(added: ReadonlyArray<AddedLine>): Array<CommentBlock> {
  const blocks: Array<CommentBlock> = [];
  let previous: AddedLine | undefined;
  let inBlockComment = false;
  let open: CommentBlock | undefined;
  for (const entry of added) {
    const syntax = syntaxOf(entry.file)!;
    const contiguous = previous?.file === entry.file && previous.line + 1 === entry.line;
    if (!contiguous) inBlockComment = false;
    previous = entry;
    const trimmed = entry.text.trim();
    const isComment = inBlockComment || COMMENT_START[syntax].test(trimmed);
    if (syntax === "slash" && isComment) {
      inBlockComment = (inBlockComment || /^\{?\/\*/.test(trimmed)) && !trimmed.includes("*/");
    }
    if (!isComment || DIRECTIVE.test(trimmed) || ISSUE_MARKER.test(textOf(trimmed))) {
      open = undefined;
      continue;
    }
    if (open && contiguous) {
      open.lines.push(trimmed);
    } else {
      open = { file: entry.file, line: entry.line, lines: [trimmed] };
      blocks.push(open);
    }
  }
  return blocks;
}

function documentsContractsExport(block: CommentBlock): boolean {
  if (
    !block.file.startsWith("packages/contracts/src/") ||
    !/^(?:\/\*\*|\*)/.test(block.lines[0]!)
  ) {
    return false;
  }
  if (!NodeFS.existsSync(block.file)) return false;
  const after = NodeFS.readFileSync(block.file, "utf8")
    .split("\n")
    .slice(block.line - 1 + block.lines.length)
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^(?:\*|\/\/|\/\*)/.test(line));
  return after?.startsWith("export ") ?? false;
}

const isKept = (block: CommentBlock) => KEEP.test(textOf(block.lines[0]!));

function isAllowed(block: CommentBlock): boolean {
  if (TEST_FILE.test(block.file)) return false;
  return (
    isKept(block) ||
    block.lines.some((line) => LICENCE.test(line)) ||
    documentsContractsExport(block)
  );
}

const target = process.argv[2];
if (
  !target &&
  NodeChildProcess.spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0
) {
  process.exit(0);
}

const diff = git([
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  ...(target ? [target] : ["--cached"]),
  "--",
]);
const added = [
  ...parseDiff(diff),
  ...(target && !target.includes("..") ? untrackedLines() : []),
].filter((entry) => syntaxOf(entry.file) && !SKIPPED.test(entry.file));
const generated = generatedFiles([...new Set(added.map((entry) => entry.file))]);
const blocks = commentBlocks(added.filter((entry) => !generated.has(entry.file)));
const flagged = blocks.filter((block) => !isAllowed(block));

if (process.env.GITHUB_ACTIONS === "true") {
  for (const block of blocks) {
    const level = flagged.includes(block) ? "error" : isKept(block) ? "notice" : undefined;
    if (level)
      process.stdout.write(`::${level} file=${block.file},line=${block.line}::${block.lines[0]}\n`);
  }
}

if (flagged.length > 0) {
  process.stderr.write(`New code comments (${flagged.length}):\n`);
  for (const block of flagged) {
    const more = block.lines.length > 1 ? `  (+${block.lines.length - 1} lines)` : "";
    process.stderr.write(`  ${block.file}:${block.line}  ${block.lines[0]}${more}\n`);
  }
  process.stderr.write(`\n${RULE}\n`);
  process.exit(1);
}
