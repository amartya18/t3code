# Fork Reliability Patches

This fork carries narrow backend and client reliability patches. Most keep T3 Code connected on hosts
where an endpoint-security agent (e.g. CrowdStrike Falcon) taxes every process spawn and file read.
It also preserves user control of the chat timeline while responses stream.

Every change is deliberately narrow and rebase-friendly. Do **not** compensate for slowness by
editing generated `dist/bin.mjs`, weakening WebSocket reconnection semantics, or making changes wider
than the ones described here.

## Behavioral contract

The patch must preserve these invariants, grouped by concern.

### Repository identity resolution (`RepositoryIdentityResolver.ts`)

1. Each `git rev-parse --show-toplevel` and `git remote -v` invocation used for repository identity
   resolution has a **five-second** timeout with `timeoutBehavior: "timedOutResult"`.
2. The repository identity cache is keyed by the workspace directory passed to `resolve(cwd)`. The
   complete lookup, including `git rev-parse`, is cached for both positive and negative results.
   Positive results use a **six-hour** TTL; negative results a one-minute TTL.
3. Normal, fast Git resolution keeps the upstream repository-selection behavior unchanged:
   `upstream` is preferred over `origin`, then the remaining remote names are sorted.
4. An interrupted cache load can be retried and must not leave a permanently pending cache entry.

### Snapshot enrichment (`ProjectionSnapshotQuery.ts`)

5. Repository identity enrichment has a **three-second** snapshot-wide budget. When the budget
   expires, the snapshot still returns every project and all non-repository fields.
6. On timeout the snapshot serves the **last known** repository identities from the previous completed
   round rather than dropping them — stale identities beat missing ones. The first ever timeout (no
   prior round) yields no identities but still returns every project.

### VCS process timeouts (`VcsProcess.ts`)

7. The `T3_VCS_TIMEOUT_SCALE` environment variable multiplies every VCS process timeout. It parses a
   positive finite number, defaults to `1` when unset/empty/invalid/non-positive, and is capped at
   `20`. On macOS it is set via `launchctl setenv` so GUI-launched apps inherit it.

### Editor discovery (`externalLauncher.ts`)

8. Editor discovery runs in the background, not inline in `getConfig`. The first caller waits at most
   a bounded interval (five seconds) for the initial scan and otherwise returns an empty editor list;
   later callers get the cached snapshot immediately and trigger an out-of-band rescan at most once
   per rescan interval (five minutes). Editor probes run concurrently.

### Client connection tolerance (`connection/*.ts`)

9. A never-connected desired session grants a **60-second boot-grace window**: transient failures
   within that window, after the first attempt, present as `connecting` (not `reconnecting`). The
   window closes on the first successful connection; reconnects after an established session dropped
   never receive boot grace.
10. The connection-establishment timeout is **30 seconds** (was 15) to leave headroom for a
    slow-booting backend; retries remain cheap and spurious failures churn the UI.

### Chat transcript copy (`conversation/transcript.ts`, `chatTranscript.ts`, `CopyWholeChatButton.tsx`)

11. The chat header carries a **Copy chat** action, first in the header action cluster. It writes a
    Markdown transcript of the active thread: the thread title as an `#` heading, then each message
    under a `## User` or `## Agent` heading. It is disabled only when no message can be copied.
12. A running turn does not block the action. The streaming message drops out of the transcript and
    the completed conversation before it still copies.
13. Prompt context that the composer appended at send time (`<terminal_context>`,
    `<element_context>`) is stripped from user messages, and attachments are not inlined. Each
    dropped part leaves a note line such as `_[1 terminal context omitted]_` or
    `_[1 image attached]_`, so nothing disappears silently. Tool activity, approvals, plans, and
    diffs stay out of the transcript.
14. Stripping runs when the action is used, never on every streamed frame.

### Chat live-follow cancellation (`ChatView.tsx`, `MessagesTimeline.tsx`)

15. Wheel, touch, and pointer navigation handlers are bound directly to the `LegendList` scroll
    container. Manual navigation cancels live-follow even when the list mounts or remounts late.
16. Sending still follows the active response until the user navigates away; explicit “Scroll to end”
    resumes live-follow.

## Maintained files

Server:

- `apps/server/src/project/RepositoryIdentityResolver.ts` (+ `.test.ts`)
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (+ `.test.ts`)
- `apps/server/src/vcs/VcsProcess.ts` (+ `.test.ts`)
- `apps/server/src/process/externalLauncher.ts` (+ `.test.ts`)

Client runtime:

- `packages/client-runtime/src/connection/model.ts`
- `packages/client-runtime/src/connection/presentation.ts` (+ `.test.ts`)
- `packages/client-runtime/src/connection/supervisor.ts` (+ `.test.ts`)
- `packages/client-runtime/src/conversation/transcript.ts` (+ `.test.ts`)

Web:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/MessagesTimeline.tsx` (+ `.test.tsx`)
- `apps/web/src/components/chat/CopyWholeChatButton.tsx` (+ `.test.tsx`)
- `apps/web/src/components/chat/chatTranscript.ts` (+ `.test.ts`)
- `apps/web/src/components/chat/ChatHeader.tsx`

The implementation constants are intentionally local to their owning modules:

```ts
// RepositoryIdentityResolver.ts
const DEFAULT_POSITIVE_CACHE_TTL = Duration.hours(6);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
const REPOSITORY_IDENTITY_PROCESS_TIMEOUT = Duration.seconds(5);

// ProjectionSnapshotQuery.ts
const REPOSITORY_IDENTITY_SNAPSHOT_TIMEOUT = Duration.seconds(3);

// externalLauncher.ts
const INITIAL_EDITOR_SCAN_WAIT = Duration.seconds(5);
const EDITOR_RESCAN_INTERVAL = Duration.minutes(5);
const EDITOR_PROBE_CONCURRENCY = 8;

// VcsProcess.ts
const VCS_TIMEOUT_SCALE_ENV_VAR = "T3_VCS_TIMEOUT_SCALE";
const MAX_TIMEOUT_SCALE = 20;

// connection/supervisor.ts
const CONNECTION_ESTABLISHMENT_TIMEOUT = "30 seconds";
const BOOT_GRACE_MS = 60_000;
```

## Syncing with upstream T3 Code

Upstream is `pingdotgg/t3code`. The `upstream` remote is already configured in this clone (push is
deliberately disabled).

**Always rebase; never fast-forward `main` onto upstream.** This fork's `main` carries the patch
commits described above — it is not a clean mirror of upstream. Syncing means replaying those patches
on top of upstream's new commits (`git rebase upstream/main`), not resetting or fast-forwarding
`main` to match `upstream/main`. A plain fork "sync" / fast-forward would fail on the divergence, and
force-resetting `main` to `upstream/main` would silently discard the fork patches. Do neither.

To sync, rebase the branch that carries the patches onto the latest upstream `main`:

```bash
git remote -v
git remote add upstream https://github.com/pingdotgg/t3code # only if it is missing
git fetch upstream
git switch main                 # or the feature branch holding the patches
git rebase upstream/main        # replays the fork patches on top of upstream
```

### Conflict policy

Apply these rules in order. They are a priority ladder, not a menu.

1. **Prefer upstream.** Take upstream's version as the base of every conflicted hunk — its
   structure, naming, control flow, and APIs. The fork's shape is not worth defending merely
   because it is familiar.
2. **Re-apply the invariants on top.** The fork exists only to satisfy the "Behavioral contract"
   above. Anything in the fork diff that is not one of those invariants is dead weight: drop it in
   favor of upstream.
3. **Never change application behavior or features to make a conflict go away.** Re-applying an
   invariant must not alter user-visible behavior, remove a feature, or weaken WebSocket
   reconnection semantics. If upstream already provides an equivalent guarantee, retire the fork
   change and record that decision in this file.
4. **Escalate to a human when 1–3 collide.** If upstream restructured a file such that the
   invariant cannot be re-expressed without changing behavior — or the correct resolution is
   genuinely ambiguous — stop with the conflict left in place, and report which invariant is at
   risk and why. Do not guess and do not silently drop an invariant.

Per-file guidance for step 2:

- `RepositoryIdentityResolver.ts`: ensure the five-second timeout is supplied to both Git commands,
  the cache lookup begins with the original `cwd`, and the positive/negative TTLs are preserved.
- `ProjectionSnapshotQuery.ts`: keep upstream's project filtering, deduplication, mapping, and
  concurrency. Apply the three-second timeout around the complete `Effect.forEach` enrichment and
  keep the last-known-identity fallback on timeout.
- `VcsProcess.ts`: keep `resolveVcsTimeoutScale` applied to the resolved timeout of every command.
- `externalLauncher.ts`: keep editor discovery off the `getConfig` critical path with the bounded
  first-scan wait and cached snapshot.
- `connection/{model,presentation,supervisor}.ts`: keep the boot-grace field and its 60-second
  window, and the 30-second establishment timeout.
- `ChatView.tsx` and `MessagesTimeline.tsx`: keep manual-navigation handlers on `LegendList`; do not
  replace them with a one-shot ref lookup or delayed DOM listener attachment.
- Tests: retain new upstream coverage and re-express the invariants above using the current test
  helpers. Test names and fixture layout may change; the behaviors may not.

After resolving, inspect the actual semantic diff:

```bash
git diff upstream/main...HEAD -- \
  apps/server/src/project/RepositoryIdentityResolver.ts \
  apps/server/src/project/RepositoryIdentityResolver.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
  apps/server/src/vcs/VcsProcess.ts \
  apps/server/src/vcs/VcsProcess.test.ts \
  apps/server/src/process/externalLauncher.ts \
  apps/server/src/process/externalLauncher.test.ts \
  packages/client-runtime/src/connection/model.ts \
  packages/client-runtime/src/connection/presentation.ts \
  packages/client-runtime/src/connection/presentation.test.ts \
  packages/client-runtime/src/connection/supervisor.ts \
  packages/client-runtime/src/connection/supervisor.test.ts \
  apps/web/src/components/ChatView.tsx \
  apps/web/src/components/chat/MessagesTimeline.tsx \
  apps/web/src/components/chat/MessagesTimeline.test.tsx \
  PATCH.md
```

If upstream independently implements equivalent guarantees, prefer upstream's implementation and
adapt or retire the corresponding fork change. Record that decision in this file so future agents do
not reintroduce duplicate timeout, caching, or grace layers.

### Retired upstream-covered changes

- **2026-08-11 — plan sidebar dismissal per thread:** Upstream removed the plan surface in the
  right-panel store migration and now shows plans in the chat transcript. The right-panel store also
  keeps its remaining surface state by thread. The fork commit that tracked plan sidebar dismissal
  by thread and turn is obsolete. Do not reapply its `ChatView` refs or auto-open effects.

## Required verification

**A rebase is not finished until these suites pass.** They are mandatory whenever the rebase
produced conflicts, and whenever it moved any maintained file listed above — a clean auto-merge is
not evidence the invariants survived upstream's refactors. Never build or install an unverified
rebase; a broken invariant shows up as a reconnect loop, not a compile error.

Run the focused suites:

```bash
vp test run \
  apps/server/src/project/RepositoryIdentityResolver.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
  apps/server/src/vcs/VcsProcess.test.ts \
  apps/server/src/process/externalLauncher.test.ts
```

```bash
vp test run \
  packages/client-runtime/src/connection/presentation.test.ts \
  packages/client-runtime/src/connection/supervisor.test.ts
```

```bash
vp test run apps/web/src/components/chat/MessagesTimeline.test.tsx
```

The suites must cover:

1. Both Git commands receive the explicit five-second timeout, and a timed-out command returns `null`.
2. Two warm `resolve(cwd)` calls invoke `git rev-parse` once; negative non-Git results are cached;
   different workspace directories have independent entries; an interrupted cache load can be retried.
3. A resolver that never completes cannot hold a snapshot past three seconds; snapshot timeout
   preserves projects and every non-repository field; a later overrun serves the last known
   identities; fast resolution still returns the normal identity.
4. `resolveVcsTimeoutScale` defaults, parses, and caps correctly, and the scale is applied to every
   VCS process timeout.
5. Editor discovery serves an empty list when the first scan outlives its wait budget.
6. Boot grace is granted to early transient failures until first connection, stops once the window
   elapses, and is denied to reconnects after an established session drops; presentation maps the
   grace window to `connecting`.
7. The chat timeline binds wheel, touch, and pointer navigation directly to `LegendList`.

Also run targeted formatting and the relevant package typecheck when available. Do not routinely run
the workspace-wide test or typecheck suites; repository CI owns full verification.

If a suite fails after a rebase, fix it under the conflict policy above — restore the invariant, or
escalate under rule 4. Do not relax an assertion or delete a test to get green.

## Building and installing this fork

A request to run `PATCH.md` and `BUILD.md` authorizes the complete sync, dependency refresh, build,
app swap, launch verification, cleanup, commit, and push to the fork's `main` branch. Recover routine
problems without asking. Examples are a missing global `vp`, stale `node_modules`, a sandboxed
command that needs its normal approval retry, an unsigned local app bundle, and the expected
lease-protected force push after a rebase. Stop only for the blocking conditions that `BUILD.md`
lists.

Build a nightly-branded macOS ZIP so it targets the same product name as the installed nightly:

```bash
vp run dist:desktop:artifact \
  --platform mac \
  --target zip \
  --arch arm64 \
  --build-version 0.0.30-nightly.20260723.1 \
  --output-dir release
```

Use a fresh version for later builds whose stable core is higher than the currently published
nightly. For example, the custom `0.0.30-nightly.*` build replaced an official
`0.0.29-nightly.*` build. This prevents the official updater from immediately replacing the fork
with a newer-date prerelease from the lower `0.0.29` core. Rebuild with another higher version before
the official channel catches up.

The ZIP contains the complete app bundle and avoids macOS DMG-helper failures in restricted build
environments. macOS `iconutil` still needs normal OS access during packaging; if it reports
`Invalid Iconset` only in a sandbox, rerun the packaging command outside that sandbox. Do not patch
the contents of an existing installed app or generated server bundle in place.

Before replacement:

1. Quit T3 Code Nightly completely.
2. Expand the ZIP to a temporary directory.
3. Verify the new bundle identifier is `com.t3tools.t3code`, verify its version, and confirm the
   packaged `apps/server/dist/bin.mjs` hash matches the just-built server bundle.
4. Use `/Users/amartya.kadarisman/fun/app/T3 Code (Nightly).app` as the destination. Do not install a
   second copy in `~/Applications` or `/Applications`.
5. Move the existing bundle out of that directory as a recoverable temporary backup, then move the
   complete new bundle into the exact same path. Restore the backup immediately if the move fails.
6. Launch the exact destination path and confirm its main process and backend process both run from
   `/Users/amartya.kadarisman/fun/app/T3 Code (Nightly).app`.
7. After successful launch verification, remove the temporary old-bundle backup and confirm
   `~/fun/app` contains exactly one `T3 Code*.app`.

Remove the temporary extraction directory and all stray `.bak-*` bundles after verification. Keep
only the new `release/T3-Code-*-arm64.zip`; delete older arm64 ZIPs so local build artifacts do not
accumulate.

After the installed app passes verification and cleanup is complete, update `origin/main` as
`BUILD.md` describes. Fetch `origin`, then push with `git push --force-with-lease origin main`.
Confirm that local `main` and `origin/main` name the same commit. Never use an unprotected force push.

An unsigned local build may require one explicit Finder launch or removal of quarantine from the
single verified app bundle. Never weaken Gatekeeper globally.

## Manual regression

Place a fake `git` earlier in `PATH` that sleeps for ten seconds and load several projects. The shell
snapshot should complete in about three seconds or less, project cards should remain available with
missing repository labels, and sessions should remain connected. Restore the normal `PATH` and verify
that repository names/providers return and a warm snapshot launches no second `git rev-parse` for the
same workspace directory. Separately, boot the desktop client against a cold backend and confirm it
shows "Connecting..." (not a reconnect failure) throughout the boot-grace window.
