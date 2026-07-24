# Endpoint-Security Reliability Patch

This fork carries a set of backend and client reliability patches so that T3 Code stays connected on
hosts where an endpoint-security agent (e.g. CrowdStrike Falcon) taxes every process spawn and file
read. On such hosts a cold backend can take tens of seconds to service its first requests, and
git-heavy paths run far slower than on the machines upstream tunes against. Without these patches the
desktop client disconnects during startup and repository metadata resolution blocks shell snapshots.

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
deliberately disabled). Keep fork work on a dedicated branch:

```bash
git remote -v
git remote add upstream https://github.com/pingdotgg/t3code # only if it is missing
git fetch upstream
git switch <fork-branch>
git rebase upstream/main
```

Resolve conflicts by preserving behavior, not by blindly choosing one side. Start from upstream's
current structure in each file, then re-apply the invariants above:

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
  PATCH.md
```

If upstream independently implements equivalent guarantees, prefer upstream's implementation and
adapt or retire the corresponding fork change. Record that decision in this file so future agents do
not reintroduce duplicate timeout, caching, or grace layers.

## Required verification

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

Also run targeted formatting and the relevant package typecheck when available. Do not routinely run
the workspace-wide test or typecheck suites; repository CI owns full verification.

## Building and installing this fork

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

An unsigned local build may require one explicit Finder launch or removal of quarantine from the
single verified app bundle. Never weaken Gatekeeper globally.

## Manual regression

Place a fake `git` earlier in `PATH` that sleeps for ten seconds and load several projects. The shell
snapshot should complete in about three seconds or less, project cards should remain available with
missing repository labels, and sessions should remain connected. Restore the normal `PATH` and verify
that repository names/providers return and a warm snapshot launches no second `git rev-parse` for the
same workspace directory. Separately, boot the desktop client against a cold backend and confirm it
shows "Connecting..." (not a reconnect failure) throughout the boot-grace window.
