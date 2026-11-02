# Fork patches

This branch (`patches`) is the personal [amartya18/t3code](https://github.com/amartya18/t3code) stack. Cherry-pick it onto any upstream **stable** tag. `main` is a 1:1 mirror of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) and must not receive these commits.

See [FORK.md](FORK.md) for install, adding patches, conflicts, and rollback.

## Behavioral contract

### Signed macOS builds without Apple Developer ID

1. `--signed` on macOS still codesigns via `scripts/sign-macos.ts` and `CSC_LINK`.
2. If `T3CODE_APPLE_TEAM_ID` and `T3CODE_MACOS_PROVISIONING_PROFILE` are both unset or empty, the build does **not** resolve passkey signing, does **not** embed a provisioning profile, and sets `mac.notarize: false`.
3. If either Apple variable is set, the upstream passkey path still runs and still fails closed on a missing profile, bad team id, or bad RP domain.
4. Bundle id stays `com.t3tools.t3code`. User-data directory stays `t3code` (legacy `T3 Code (Alpha)`).

### GitHub-hosted CI on this fork

5. `ci.yml` and `mobile-fingerprint-check.yml` use GitHub-hosted runners when `github.repository_owner != pingdotgg`. pingdotgg keeps Blacksmith.

## Maintained files

- `scripts/build-desktop-artifact.ts` (+ `.test.ts`)
- `.github/workflows/ci.yml`
- `.github/workflows/mobile-fingerprint-check.yml`

## Dropped from upstream signing

- Notarization (no Apple notary credentials)
- Associated-domain / passkey entitlements (no Apple team provisioning profile)
- Clerk desktop passkeys on this fork
