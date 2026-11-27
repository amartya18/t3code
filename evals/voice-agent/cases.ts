// Source: the 27 Nov voice trial, where relay turns took 1.8 to 3.9 s to first words because the
// agent called a tool before speaking. The direct-answer and call-ending cases are controls.
export interface VoiceCase {
  readonly id: string;
  readonly line: string;
  readonly tools: ReadonlyArray<"t3_home_send" | "t3_home_read">;
  readonly speaksBeforeTool?: true;
  readonly answer?: RegExp;
  readonly endsCall?: boolean;
  readonly startsWith?: string;
}

export const cases: ReadonlyArray<VoiceCase> = [
  {
    id: "relay",
    line: "ask Home whether PR 50 merged",
    tools: ["t3_home_send"],
    speaksBeforeTool: true,
  },
  {
    id: "arithmetic",
    line: "what's twelve times twelve",
    tools: [],
    answer: /144|hundred (and )?forty[- ]four/i,
  },
  {
    id: "home-status",
    line: "what's Home up to",
    tools: ["t3_home_read"],
    speaksBeforeTool: true,
  },
  {
    id: "general-knowledge",
    line: "remind me what git rebase does",
    tools: [],
    answer: /commit/i,
  },
  { id: "goodbye", line: "okay that's all, bye", tools: [], endsCall: true },
  { id: "bye-then-more", line: "bye bye, wait, one more thing", tools: [], endsCall: false },
  {
    id: "home-update",
    line: "[Home update] Home replied: **PR #50** merged as `9f3c2a1e` into main. Details: https://github.com/acme/app/pull/50, fix in apps/web/src/login.ts.",
    tools: [],
    startsWith: "Home says",
  },
];

export const HOME_STATUS = JSON.stringify({
  on: true,
  messages: [
    {
      from: "home",
      text: "Working on the login redirect fix for acme/app. Two threads are running: PR 50 review fixes and a flaky test hunt.",
    },
  ],
});
