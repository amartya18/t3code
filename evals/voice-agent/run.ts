// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain script around the Claude Agent SDK, which is promise-based.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { HomeToolkit } from "../../apps/server/src/mcp/toolkits/home/tools.ts";
import { cases, HOME_STATUS } from "./cases.ts";
import { ackBlock, grade, timings, type Block, type Sample, type ToolCall } from "./grade.ts";

const PROJECT = "apps/mobile/src/features/home-voice/voice-project";
const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    ref: { type: "string" },
    claude: { type: "string" },
    model: { type: "string", default: "opus" },
    effort: { type: "string", default: "low" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    baseline: { type: "string" },
  },
});
const samples = Number(values.samples);
const selected = cases.filter((c) => !values.case || values.case.split(",").includes(c.id));
const effort = values.effort as "low" | "medium" | "high" | "xhigh" | "max";
if (!values.out || !selected.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <dir> [--ref <git ref>] [--claude <executable>] [--case <ids>] [--samples <n>] [--baseline <results.json>].",
  );
}
const repo = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// Outside the repo, so the repo's own CLAUDE.md never loads into the voice agent.
async function copyProject(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-"));
  if (!values.ref) {
    await NodeFSP.cp(NodePath.join(repo, PROJECT), dir, { recursive: true });
    return dir;
  }
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  for (const file of git("ls-tree", "-r", "--name-only", values.ref, "--", PROJECT).split("\n")) {
    if (!file) continue;
    const target = NodePath.join(dir, NodePath.relative(PROJECT, file));
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, git("show", `${values.ref}:${file}`));
  }
  return dir;
}

function homeServer(calls: ToolCall[]) {
  const stub = (name: "t3_home_send" | "t3_home_read", reply: string) => {
    const real = HomeToolkit.tools[name];
    const schema = z.fromJSONSchema(advertisedJsonSchema(real)) as z.ZodObject;
    return tool(name, real.description ?? "", schema.shape, async (input) => {
      calls.push({ name, input });
      return { content: [{ type: "text", text: reply }] };
    });
  };
  return createSdkMcpServer({
    name: "t3-code",
    tools: [
      stub("t3_home_send", JSON.stringify({ delivery: "started" })),
      stub("t3_home_read", HOME_STATUS),
    ],
  });
}

const env: Record<string, string | undefined> = {
  ...process.env,
  ENABLE_TOOL_SEARCH: "false",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};
// Subscription login only: never let a key in the environment bill the API.
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"]) delete env[name];

async function runSample(line: string, cwd: string): Promise<Sample> {
  const calls: ToolCall[] = [];
  const blocks: Array<{ -readonly [K in keyof Block]: Block[K] }> = [];
  let sentAt = 0;
  let release = () => {};
  const ready = new Promise<void>((resolve) => (release = resolve));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await ready;
    sentAt = performance.now();
    yield {
      type: "user",
      message: { role: "user", content: line },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }
  const session = query({
    prompt: prompt(),
    options: {
      cwd,
      model: values.model,
      effort,
      settingSources: ["project"],
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // The voice wrapper turns this into --thinking=disabled, as T3 does for voice threads.
      thinking: { type: "adaptive", display: "summarized" },
      env,
      mcpServers: { "t3-code": homeServer(calls) },
      ...(values.claude ? { pathToClaudeCodeExecutable: values.claude } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          buildRuntimeInstructions({ harness: "Claude Code" }) + T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      },
    },
  });
  await session.initializationResult();
  release();
  let offset = 0;
  let model = "";
  for await (const message of session) {
    if (message.type === "system" && message.subtype === "init") {
      model = message.model;
      if (message.apiKeySource !== "none") {
        session.close();
        throw new Error(`Refusing to run on ${message.apiKeySource}; use a subscription login.`);
      }
    }
    if (message.type === "result") break;
    if (message.type !== "stream_event") continue;
    const at = Math.round(performance.now() - sentAt);
    const event = message.event;
    if (event.type === "message_start") offset = blocks.length;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "text" || block.type === "thinking" || block.type === "tool_use") {
        blocks[offset + event.index] = {
          type: block.type,
          startedAt: at,
          text: "",
          ...(block.type === "tool_use" ? { tool: block.name } : {}),
        };
      }
    }
    if (event.type === "content_block_delta") {
      const block = blocks[offset + event.index];
      const delta =
        event.delta.type === "text_delta"
          ? event.delta.text
          : event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : "";
      if (block && delta) {
        block.text += delta;
        if (block.firstCharAt === undefined && delta.trim()) block.firstCharAt = at;
      }
    }
  }
  session.close();
  return { model, blocks: blocks.filter(Boolean), calls };
}

const median = (xs: ReadonlyArray<number | undefined>) => {
  const sorted = xs.filter((x): x is number => x !== undefined).toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined;
};

const results = [];
for (const voiceCase of selected) {
  for (let sample = 1; sample <= samples; sample++) {
    const cwd = await copyProject();
    try {
      const run = await runSample(voiceCase.line, cwd);
      const graded = grade(voiceCase, run);
      results.push({
        id: voiceCase.id,
        sample,
        ...graded,
        ack: ackBlock(run),
        ...timings(run),
        ...run,
      });
      console.log(
        voiceCase.id,
        sample,
        graded.pass ? "pass" : "FAIL",
        JSON.stringify(graded.checks),
      );
    } finally {
      await NodeFSP.rm(cwd, { recursive: true, force: true });
    }
  }
}

type Row = (typeof results)[number];
const summarize = (rows: ReadonlyArray<Row>) =>
  Object.fromEntries(
    selected.map((c) => {
      const mine = rows.filter((row) => row.id === c.id);
      const acks = mine.map((row) => row.ack).filter((ack) => ack !== null);
      return [
        c.id,
        {
          passed: `${mine.filter((row) => row.pass).length}/${mine.length}`,
          ...(acks.length ? { ackBlock: acks.join(",") } : {}),
          medianFirstTextMs: median(mine.map((row) => row.firstTextAt)),
          medianToolMs: median(mine.map((row) => row.toolAt)),
        },
      ];
    }),
  );
const summary = {
  instructions: values.ref ?? "working tree",
  model: values.model,
  effort,
  cases: summarize(results),
  ...(values.baseline
    ? {
        baseline: summarize(
          JSON.parse(await NodeFSP.readFile(values.baseline, "utf8")) as ReadonlyArray<Row>,
        ),
      }
    : {}),
};
await NodeFSP.mkdir(values.out, { recursive: true });
await NodeFSP.writeFile(
  NodePath.join(values.out, "results.json"),
  JSON.stringify(results, null, 2),
);
await NodeFSP.writeFile(
  NodePath.join(values.out, "summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
