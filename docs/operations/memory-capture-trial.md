# Memory capture trial

Memory capture reads finished threads and proposes lasting facts for the wiki: decisions,
preferences, corrections, and facts about you, your projects, machines and services. The trial
writes candidates to a local file for a week so we can measure them. It never writes to the wiki.

## Turn it on and off

On the server host, add this to `~/.t3/userdata/settings.json`. The server watches the file, so
the change applies without a restart.

```json
"memoryCapture": {
  "mode": "trial",
  "excludeProjectIds": ["<curator project id>"]
}
```

Exclude the wiki curator's project, or capture re-reads the notes it merges. Set `mode` to
`"off"` to stop. Optional fields: `scope` (`"home"`, `"subagents"` or `"all"`, the default),
`modelSelection` (Claude Haiku by default) and `trialDir`.

Only activity after the first switch to trial is captured. A thread is read once it has been
quiet for 12 minutes after a run, or at once when it is settled or archived. A daily sweep
catches anything missed.

## Files

The trial dir defaults to `$XDG_DATA_HOME/t3-capture/trial`, or
`~/.local/share/t3-capture/trial`.

- `candidates.jsonl` is append-only. A `candidate` line holds one proposed note, labelled
  with its source thread, cited positions, attribution and `dropped` reason, if any, plus the
  exact `append_note` input it would send. A `run` line follows each extraction with its
  prompt size, candidate counts and duration.
- `cursors.json` records how far each thread has been read. The newest `run` line wins if the
  two disagree, so a crash never repeats an extraction.

## Review at the end of the week

1. Copy `candidates.jsonl` so the trial can keep appending.
2. For each kept candidate (`dropped: null`), read its source thread and grade it. Is it true?
   Is the attribution right? Is it worth keeping?
3. Compare it with the current wiki pages and pending inbox notes (`read_page` and `search`
   return both). Mark it a duplicate or new.
4. Two models from different families grade independently. Each appends one entry to the
   candidate's `grades` array:
   `{ "grader", "true", "attributionCorrect", "worthKeeping", "duplicate", "note"? }`.
   The review thread reads the wiki but never writes to it.
5. Run `node scripts/memory-capture-rates.ts <graded.jsonl>`. It prints strict rates (every
   grader agreed) per thread kind, grader disagreements, downgrades, and drops by reason.

## Before going live

- A Cloudflare service token so the server can call the wiki's `append_note`.
- An `append_note` dedupe key, so a retried call cannot add a note twice.
- An outbox that commits notes before sending, so a crash neither loses nor repeats one.
- A curator rule for notes marked "Agent proposal, not confirmed by Amar".
