# BUILD — sync, build, and swap the installed app

Runbook for the agent. Do these steps in order and finish the full build, swap, verification, and
cleanup in one run. A request to run this file authorizes the routine actions below, including the
fetch, rebase, dependency install, build, app quit, bundle swap, relaunch, and cleanup. Do not stop
to ask about a missing global `vp`, stale dependencies, a sandbox retry, an unsigned local bundle,
or files that this runbook tells you to delete. Use the repository-local `node_modules/.bin/vp`
when `vp` is not on `PATH`.

Stop only when the worktree is dirty before the sync, the conflict policy requires human judgment,
a required check fails and cannot be fixed without weakening the contract, or the operating system
denies an action after the normal approval retry. Background and rationale live in
[PATCH.md](PATCH.md); this file is the mechanics only.

## 1. Sync with upstream

Read PATCH.md and follow its "Syncing with upstream T3 Code" section: **rebase, never fast-forward
or reset `main`.**

```bash
git status --short            # must be clean; stop and ask if not
git fetch upstream
git rebase upstream/main
```

On conflicts, resolve them under PATCH.md's **conflict policy** — prefer upstream, re-apply the
invariants on top, never change application behavior or features to make a conflict go away, and
escalate to the user when those collide. Skip the sync entirely only if the user explicitly says
"build only".

If the rebase changed anything — conflicts, or new upstream commits touching PATCH.md's maintained
files — run PATCH.md's **Required verification** suites before building. Failures are fixed under
the conflict policy or escalated; never loosen a test to get green, and never build an unverified
rebase. If the rebase was a no-op, go straight to the build.

Refresh dependencies after a rebase changes `package.json`, `pnpm-lock.yaml`, or package metadata.
Also refresh them if a required module is missing. This is routine recovery. Run it and continue
without asking:

```bash
./node_modules/.bin/vp i
```

## 2. Pick the version

Format: `<core>-nightly.<YYYYMMDD>.<N>`. The `-nightly.\d{8}.\d+` suffix is what gives the build
"T3 Code (Nightly)" branding — a version without it builds the wrong product.

- `<core>`: one patch above upstream's published nightly core, so the official updater never
  replaces this build with a newer-dated upstream prerelease.

  ```bash
  git tag --sort=-creatordate | grep nightly | head -1   # e.g. v0.0.29-nightly.20260724.889 -> core 0.0.30
  ```

- `<YYYYMMDD>`: today.
- `<N>`: 1, or one more than the highest `N` already in `release/` for today.

  ```bash
  ls release/*.zip
  ```

## 3. Build

~6 minutes. `--target zip` is required. The artifact copier only copies files, so `--target dir`
output is silently discarded.

```bash
PATH="$PWD/node_modules/.bin:$PATH" node scripts/build-desktop-artifact.ts \
  --platform mac --target zip --arch arm64 \
  --build-version <version> --output-dir release
```

Produces `release/T3-Code-<version>-arm64.zip`.

## 4. Swap the installed app

Destination is exactly `~/fun/app/T3 Code (Nightly).app` (dir is `~/fun/app`, singular). Never
install a second copy in `~/Applications` or `/Applications`, and never patch a bundle in place.

1. Quit the app: `osascript -e 'quit app "T3 Code (Nightly)"'`, then confirm no process remains.
2. Unzip the new artifact to a `mktemp -d` directory. Record that exact directory and remove it on
   success or failure. Verify the app before touching the installed bundle:
   bundle id is `com.t3tools.t3code` and `CFBundleShortVersionString` matches `<version>`.
3. Move the current bundle aside to `~/fun/app/.T3 Code (Nightly).app.bak-<short-sha>-<version>`.
   This is a transient rollback slot for the next step only — **backups are never retained**, see
   step 5.
4. Move the new bundle into the exact destination path. If the move fails, restore the backup
   immediately.
5. Set `T3_VCS_TIMEOUT_SCALE` before launch so the new GUI process inherits it, then relaunch the
   exact installed path:

   ```bash
   launchctl setenv T3_VCS_TIMEOUT_SCALE 3
   open "$HOME/fun/app/T3 Code (Nightly).app"
   ```

   An unsigned local build may need one explicit Finder launch or a quarantine removal on that one
   bundle. Never weaken Gatekeeper globally.

## 5. Verify, then clean up

```bash
curl -s http://127.0.0.1:3773/.well-known/t3/environment
```

- The descriptor should respond (backend cold start can take 30–40s on this host).
- Main and backend processes must both run from `~/fun/app/T3 Code (Nightly).app`.
- Logs: `~/.t3/userdata/logs/server-child.log`, `server.trace.ndjson*`.

Once the app is confirmed healthy, delete this run's backup. **Do not retain app-bundle backups, and
do not ask about them.** Also delete any stray `.bak-*` bundles from earlier runs in the same pass.
They are ~735 MB each and accumulate fast. Remove the temporary extraction directory. In `release/`,
keep the new ZIP and delete older `T3-Code-*-arm64.zip` files. The new versioned artifact is the
recovery path, so a bad build is re-swapped from that ZIP instead of an old bundle or old artifact.

Finish by confirming that `~/fun/app` contains exactly one `T3 Code*.app` and no `.bak-*` bundles,
the temporary directory is gone, and `release/` contains only the new arm64 ZIP. `~/fun/app` also
holds unrelated apps. "Exactly one" means one _T3 Code_ bundle, not one app.

## Report back

The version built; what the rebase pulled in and whether it conflicted; the test results if the
suites ran; and the post-launch verification result. Say plainly if any step was skipped.
