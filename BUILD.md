# BUILD — sync, build, and swap the installed app

Runbook for the agent. Do these steps in order, stop and ask on anything unexpected.
Background and rationale live in [PATCH.md](PATCH.md); this file is the mechanics only.

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

~6 minutes. `--target zip` is required — the artifact copier only copies files, so `--target dir`
output is silently discarded.

```bash
node scripts/build-desktop-artifact.ts \
  --platform mac --target zip --arch arm64 \
  --build-version <version> --output-dir release
```

Produces `release/T3-Code-<version>-arm64.zip`.

## 4. Swap the installed app

Destination is exactly `~/fun/app/T3 Code (Nightly).app` (dir is `~/fun/app`, singular). Never
install a second copy in `~/Applications` or `/Applications`, and never patch a bundle in place.

1. Quit the app: `osascript -e 'quit app "T3 Code (Nightly)"'`, then confirm no process remains.
2. Unzip the new artifact to a temp dir and verify it before touching the installed bundle:
   bundle id is `com.t3tools.t3code` and `CFBundleShortVersionString` matches `<version>`.
3. Move the current bundle aside to a recoverable backup:
   `~/fun/app/.T3 Code (Nightly).app.bak-<short-sha>-<version>`.
4. Move the new bundle into the exact destination path. If the move fails, restore the backup
   immediately.
5. Relaunch: `open "$HOME/fun/app/T3 Code (Nightly).app"`. An unsigned local build may need one
   explicit Finder launch or a quarantine removal on that one bundle — never weaken Gatekeeper
   globally.

## 5. Verify, then clean up

```bash
launchctl setenv T3_VCS_TIMEOUT_SCALE 3     # GUI apps only inherit env set this way
curl -s http://127.0.0.1:3773/.well-known/t3/environment
```

- The descriptor should respond (backend cold start can take 30–40s on this host).
- Main and backend processes must both run from `~/fun/app/T3 Code (Nightly).app`.
- Logs: `~/.t3/userdata/logs/server-child.log`, `server.trace.ndjson*`.

Once the app is confirmed healthy, delete this run's backup and confirm `~/fun/app` contains
exactly one `T3 Code*.app`. Older `.bak-*` bundles can be removed too — ask first.

## Report back

The version built; what the rebase pulled in and whether it conflicted; the test results if the
suites ran; and the post-launch verification result. Say plainly if any step was skipped.
