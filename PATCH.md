# Repository Identity Reliability Patch

This fork carries a small backend reliability patch that keeps optional Git repository metadata from
delaying orchestration shell snapshots long enough to disconnect a T3 Code client.

## Behavioral contract

The patch must preserve these invariants:

1. Each `git rev-parse --show-toplevel` and `git remote -v` invocation used for repository identity
   resolution has a one-second timeout with `timeoutBehavior: "timedOutResult"`.
2. The repository identity cache is keyed by the workspace directory passed to `resolve(cwd)`. The
   complete lookup, including `git rev-parse`, is cached for both positive and negative results.
3. Repository identity enrichment has a three-second snapshot-wide budget. When the budget expires,
   the snapshot still returns every project and all non-repository fields, with
   `repositoryIdentity: null`.
4. Normal, fast Git resolution keeps the upstream repository-selection behavior unchanged:
   `upstream` is preferred over `origin`, then the remaining remote names are sorted.
5. An interrupted cache load can be retried and must not leave a permanently pending cache entry.

This is deliberately a narrow patch. Do not compensate by increasing the frontend connection timeout,
changing WebSocket reconnection, reducing repository-resolution concurrency, changing cache TTLs, or
editing generated `dist/bin.mjs`.

## Maintained files

- `apps/server/src/project/RepositoryIdentityResolver.ts`
- `apps/server/src/project/RepositoryIdentityResolver.test.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`

The implementation constants are intentionally local to their owning modules:

```ts
const REPOSITORY_IDENTITY_PROCESS_TIMEOUT = Duration.seconds(1);
const REPOSITORY_IDENTITY_SNAPSHOT_TIMEOUT = Duration.seconds(3);
```

## Syncing with upstream T3 Code

Use an `upstream` remote for the non-fork repository and keep fork work on a dedicated branch:

```bash
git remote -v
git remote add upstream <non-fork-t3code-url> # only when it does not already exist
git fetch upstream
git switch <fork-branch>
git rebase upstream/main
```

Resolve conflicts by preserving behavior, not by blindly choosing one side:

- In `RepositoryIdentityResolver.ts`, start from upstream's current resolver structure, then make sure
  the timeout is still supplied to both Git commands and the cache lookup begins with the original
  `cwd`.
- In `ProjectionSnapshotQuery.ts`, keep upstream's current project filtering, deduplication, mapping,
  and concurrency. Apply the three-second timeout around the complete `Effect.forEach` enrichment and
  use an empty entry list on timeout.
- In tests, retain new upstream coverage and re-express the behavioral contract above using the
  current test helpers. Test names and fixture layout may change; the nine behaviors below may not.

After resolving, inspect the actual semantic diff:

```bash
git diff upstream/main...HEAD -- \
  apps/server/src/project/RepositoryIdentityResolver.ts \
  apps/server/src/project/RepositoryIdentityResolver.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
  PATCH.md
```

If upstream independently implements equivalent guarantees, prefer upstream's implementation and
adapt or retire this fork patch. Record that decision in this file so future agents do not reintroduce
duplicate timeout or caching layers.

## Required verification

Run the focused backend tests:

```bash
vp test run \
  apps/server/src/project/RepositoryIdentityResolver.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts
```

The focused suite must cover:

1. Both Git commands receive the explicit one-second timeout.
2. A timed-out Git command returns `null`.
3. Two warm `resolve(cwd)` calls invoke `git rev-parse` once.
4. Negative non-Git results are cached.
5. Different workspace directories have independent entries.
6. A resolver that never completes cannot hold a snapshot past three seconds.
7. Snapshot timeout preserves projects and every non-repository project field.
8. Fast resolution still returns the normal identity.
9. An interrupted cache load can be retried.

Also run targeted formatting and the server typecheck when available. Do not routinely run the
workspace-wide test or typecheck suites; repository CI owns full verification.

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
same workspace directory.
