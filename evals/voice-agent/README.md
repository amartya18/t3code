# Voice agent

Checks the fork's voice agent instructions (`apps/mobile/src/features/home-voice/voice-project`): it speaks a few words before any tool call, answers what it can without Home, relays the rest once, keeps replies plain and short, and ends the call only on a clear goodbye.

It runs real Claude Code sessions through the Claude Agent SDK on your Claude subscription login. Home's tools are stubs with the real descriptions and schemas that record calls. The run refuses an API key. Each sample starts a fresh session in a temporary copy of the voice project outside the repo, and its clock starts only after the session is up, so the timings cover the model turn and not process startup.

Run from `evals/`:

```sh
pnpm voice-agent --out runs/voice-agent-old --ref origin/main --claude <claude executable>
pnpm voice-agent --out runs/voice-agent --claude <claude executable> --baseline runs/voice-agent-old/results.json
```

`--ref` reads the instructions from a git ref instead of the working tree. `--claude` should be the wrapper voice threads use to turn thinking off. Defaults are `--model opus --effort low --samples 3`. Use `--case relay --samples 1` for a smoke run.

`summary.json` gives pass counts per case, where the words before a tool call landed (`text`, or `thinking`, which the phone never speaks), and median milliseconds from sending the line to the first spoken character and to the first tool call. `results.json` keeps every block. A full run is 21 short turns, about three minutes.
