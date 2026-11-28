import type { VoiceCase } from "./cases.ts";

/** One content block of the agent's reply, timed from when its prompt was sent. */
export interface Block {
  readonly type: "text" | "thinking" | "tool_use";
  readonly startedAt: number;
  /** When the first visible character arrived; absent for blocks that stayed empty. */
  readonly firstCharAt?: number;
  readonly text: string;
  readonly tool?: string;
}

export interface ToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface Sample {
  readonly model: string;
  readonly blocks: ReadonlyArray<Block>;
  readonly calls: ReadonlyArray<ToolCall>;
}

const END_CALL = "[end call]";
const NOT_PLAIN: ReadonlyArray<RegExp> = [
  /[*_`#]/,
  /^\s*[-•]\s/m,
  /\]\(/,
  /https?:\/\//,
  /\b[\w.-]+\/[\w.-]+\/[\w./-]+/,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i,
];

/** The text Amar hears: text blocks only, since the app never speaks thinking. */
export const spokenText = (sample: Sample) =>
  sample.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();

/** Where the words before the first tool call landed, or null when no tool ran. */
export const ackBlock = (sample: Sample): "text" | "thinking" | "none" | null => {
  const firstTool = sample.blocks.findIndex((block) => block.type === "tool_use");
  if (firstTool === -1) return null;
  const before = sample.blocks.slice(0, firstTool).filter((block) => block.text.trim() !== "");
  if (before.some((block) => block.type === "text")) return "text";
  return before.length > 0 ? "thinking" : "none";
};

export const timings = (sample: Sample) => ({
  firstTextAt: sample.blocks.find((block) => block.type === "text" && block.firstCharAt)
    ?.firstCharAt,
  toolAt: sample.blocks.find((block) => block.type === "tool_use")?.startedAt,
});

export function grade(voiceCase: VoiceCase, sample: Sample) {
  const spoken = spokenText(sample);
  const speech = spoken.replace(END_CALL, "").trim();
  const checks: Record<string, boolean> = {
    tools:
      sample.calls.map((call) => call.name).join() === voiceCase.tools.join() &&
      (voiceCase.tools[0] !== "t3_home_send" ||
        String(sample.calls[0]?.input.message ?? "").startsWith("Amar (voice): ")),
    plain: speech !== "" && NOT_PLAIN.every((pattern) => !pattern.test(speech)),
    short: (speech.match(/[.!?](\s|$)/g) ?? []).length <= 3,
  };
  if (voiceCase.speaksBeforeTool) checks.speaksBeforeTool = ackBlock(sample) === "text";
  if (voiceCase.answer) checks.answer = voiceCase.answer.test(spoken);
  if (voiceCase.startsWith) checks.startsWith = spoken.startsWith(voiceCase.startsWith);
  if (voiceCase.endsCall !== undefined) {
    checks.endsCall = voiceCase.endsCall
      ? spoken.endsWith(END_CALL) && spoken.indexOf(END_CALL) === spoken.length - END_CALL.length
      : !spoken.includes(END_CALL);
  }
  return { checks, pass: Object.values(checks).every(Boolean) };
}
