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

### Home agent (from pingdotgg/t3code#15975)

8. Desktop hub can run one Home thread that acts across projects and connected environments via `fleet.invoke` / `fleetConnect`.
9. Settings → Home turns it on and off. The Home folder is not the default new-thread project. macOS hide-on-close stays alive while Home is on.
10. Ordinary MCP tools keep v0.1.6 schemas. Home routing (`callerIsHome`, `routeHome`, `runAsHome`) is added so Home can list/launch/organize/respond across the fleet. Home's own tools register through `McpToolAccess.toLayer`, not `Toolkit.toLayer`. `RemoteDelegation` loads `ProjectToolkit` on demand so project/orchestrator tools can declare `homeRoutingDependencies` without a `FleetService` init cycle.
11. Home adds `t3_environment_list` and `t3_thread_watch`, which raises `mcpToolListJsonBytes` from 46109 to 47631. The `agent-context-increase` label is required so the budget workflow accepts that growth versus `main`.

## Maintained files

- `scripts/build-desktop-artifact.ts` (+ `.test.ts`)
- `.github/workflows/ci.yml`
- `.github/workflows/mobile-fingerprint-check.yml`
- `apps/server/src/storageCleanup.test.ts`
- `apps/server/src/usage/UsageService.test.ts`
- `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx`
- `apps/server/src/home/*`, `apps/server/src/mcp/homeRouting.ts`, `apps/server/src/mcp/toolkits/home/*`
- `packages/contracts/src/home.ts`
- `apps/web/src/components/home/*`, `apps/web/src/routes/_chat.settings.home.tsx`

## Dropped from upstream signing

- Notarization (no Apple notary credentials)
- Associated-domain / passkey entitlements (no Apple team provisioning profile)
- Clerk desktop passkeys on this fork

## Dropped from Home PR 15975

- Preview-automation RPCs (v0.1.6 already removed them).
- MCP tool splits (`t3_queue_*`, split pending-request tools, split thread transfer tools). v0.1.6 combined tools stay, with Home routing inside.
- Home's older `t3-thread://v1/<env>/<thread>` hrefs. New Home links use v0.1.6 v2.
- Mobile ThreadFeed hunks (no Home behavior; v0.1.6 already has thread links).
- "Watch report from T3 Code" / "Sent by Home" timeline labels (that code moved to `TimelineUserMessageRow.tsx` on v0.1.6 and was not re-wired).
- Global `home.open` (mod+shift+0) command-palette handler (shortcut is shown; the v0.1.6 dispatcher was not extended).
- Cross-environment "open related thread" from ChatView (that logic lives in `useThreadLifecycle.tsx` on v0.1.6).
