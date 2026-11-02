# Fork patches

This branch (`patches`) is the personal [amartya18/t3code](https://github.com/amartya18/t3code) stack. Cherry-pick it onto any upstream **stable** tag. `main` is a 1:1 mirror of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) and must not receive these commits.

See [FORK.md](FORK.md) for install, adding patches, conflicts, and rollback.

## Behavioral contract

### Signed macOS builds without Apple Developer ID

1. `--signed` on macOS still codesigns via `scripts/sign-macos.ts` and `CSC_LINK`.
2. If `T3CODE_APPLE_TEAM_ID` and `T3CODE_MACOS_PROVISIONING_PROFILE` are both unset or empty, the build does **not** resolve passkey signing, does **not** embed a provisioning profile, sets `mac.notarize: false` and `mac.forceCodeSigning: true`, and signs with hardened-runtime entitlements (JIT, disable-library-validation, camera, microphone) that do **not** include associated-domains or a team identifier.
3. If either Apple variable is set, the upstream passkey path still runs and still fails closed on a missing profile, bad team id, or bad RP domain.
4. Bundle id stays `com.t3tools.t3code`. User-data directory stays `t3code` (legacy `T3 Code (Alpha)`).

### GitHub-hosted CI on this fork

5. `ci.yml` and `mobile-fingerprint-check.yml` use GitHub-hosted `ubuntu-24.04` / `macos-latest` when `github.repository_owner != pingdotgg`. pingdotgg keeps Blacksmith. `ubuntu-latest` is Ubuntu 26, which Playwright 1.60 cannot install Chromium on.
6. Two v0.1.6 tests are adjusted so GitHub-hosted CI can go green: storage cleanup accepts Git 2.56's gitfile fatal instead of treating a missing gitdir as a branch change, and the usage "windows it reaches" fixture stays inside the 92-day cache retention window via `Clock.currentTimeMillis` (not `Date.now()`, which lint forbids in tests).
7. The workspace PDF scroll/zoom browser test waits up to 30s for `1 / 3 pages` and has a 60s test budget. GitHub-hosted `ubuntu-24.04` (4 vCPU) is slower than Blacksmith 8vcpu; the 15s default cuts off first paint.

### Daily stable sync

7. `.github/workflows/fork-stable-release.yml` runs on a daily cron and on `workflow_dispatch`. It publishes only a plain `vX.Y.Z` upstream stable tag, never a nightly.
8. A day with no new stable tag, or a tag this fork already released, exits 0 and publishes nothing.
9. Otherwise it checks out that upstream tag, cherry-picks `merge-base(patches_ref, tag)..patches_ref` (default `patches_ref` is `patches`), builds macOS arm64 with `--signed`, and publishes a GitHub Release whose version equals the upstream tag. `app-update.yml` must name `amartya18/t3code` or the job fails before publish.
10. A cherry-pick conflict, a missing `CSC_LINK`, or a build failure opens a GitHub issue and publishes nothing.

## Maintained files

- `scripts/build-desktop-artifact.ts` (+ `.test.ts`)
- `scripts/fork-stable-sync.ts` (+ `scripts/lib/fork-stable-sync.ts`)
- `.github/workflows/ci.yml`
- `.github/workflows/mobile-fingerprint-check.yml`
- `.github/workflows/fork-stable-release.yml`
- `apps/server/src/storageCleanup.test.ts`
- `apps/server/src/usage/UsageService.test.ts`
- `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx`

## Dropped from upstream signing

- Notarization (no Apple notary credentials)
- Associated-domain / passkey entitlements (no Apple team provisioning profile)
- Clerk desktop passkeys on this fork
