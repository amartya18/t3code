# Amartya's T3 Code fork

This repository tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). `main` is a 1:1 mirror. Fork behavior lives on `patches` and is cherry-picked onto each upstream **stable** tag by `.github/workflows/fork-stable-release.yml`.

The contract for those patches is [PATCH.md](PATCH.md).

## First install

1. Wait for a GitHub Release on [amartya18/t3code](https://github.com/amartya18/t3code/releases) with a macOS zip or dmg and `latest-mac.yml`.
2. Download the arm64 zip or dmg. This is a self-signed build, not a Developer ID build.
3. Open it. Gatekeeper will warn. Open anyway from System Settings → Privacy & Security, or right-click Open.
4. Keychain may ask to trust the signing identity. Allow it. Later updates from this fork use the same identity, so Squirrel.Mac accepts them.
5. Do not replace an official T3 Code install in place and expect the official updater to switch feeds. Official builds look at pingdotgg/t3code. This fork's `app-update.yml` looks at amartya18/t3code. Install this build as your daily app if you want fork updates. Bundle id and user-data dir match upstream (`com.t3tools.t3code`, `~/Library/Application Support/t3code` with legacy `T3 Code (Alpha)`), so existing threads stay.

## Add or change a patch

1. Branch from `patches`.
2. Make one concern. Keep it rebase-friendly.
3. Update [PATCH.md](PATCH.md) in the same change.
4. Open a PR that targets `patches`, not `main`. Do not merge into `main`.

## Conflicts

The daily workflow cherry-picks `patches` onto the newest upstream stable tag. If git cannot apply a patch, it opens a GitHub issue and publishes nothing. Rebase `patches` onto the new tag, restore the PATCH.md invariants, and re-run the workflow.

Prefer upstream on conflicted hunks, then re-apply only the contract in PATCH.md. If the invariant cannot be re-expressed without changing behavior, leave the conflict and say which invariant is at risk.

## Rollback

- App: download an older fork release zip and replace the `.app`. Same signing identity, so this is a downgrade the updater will try to replace on the next check.
- Patches: reset `patches` to the last known-good commit. `main` stays a mirror; do not rewind it with fork commits.
- Stop taking updates: quit the app, or switch back to an official pingdotgg build (that is a different signing identity; it will not consume this feed).
