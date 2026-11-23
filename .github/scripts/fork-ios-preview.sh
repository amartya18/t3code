#!/usr/bin/env bash
# Ships the checked-out commit to the fork's ad hoc iOS preview app (EAS project
# @amartya18/t3-code, channel "preview"). An OTA update reaches only a binary with the same
# native fingerprint, so when no preview build has this commit's fingerprint, it starts one
# instead. Needs EXPO_TOKEN or `eas login`, and the mobile app's dependencies installed.
#
# Usage: fork-ios-preview.sh [--dry-run] [--message <text>]
set -Eeuo pipefail

dry_run=false
message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --message) message="${2:?--message needs a value}"; shift ;;
    *) echo "usage: $0 [--dry-run] [--message <text>]" >&2; exit 2 ;;
  esac
  shift
done

# The Actions log and summary are public, and EAS, npx and jq output can carry the ad hoc
# profile's device UDIDs and names, build and update IDs, and build or IPA links. There, all of
# it is hidden and only values this script checked are printed.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  exec 2>/dev/null
  trap 'echo "::error::fork-ios-preview.sh failed at line $LINENO (exit $?). Tool output is hidden on public CI; run the script by hand to see why."' ERR
fi

cd "$(dirname "$0")/../../apps/mobile"
message="${message:-$(git log -1 --format='%h %s')}"

# The fork's identity: without it, app.config.ts resolves upstream's EAS project.
export T3CODE_APPLE_TEAM_ID=C59T73GS6H
export T3CODE_IOS_BUNDLE_ID_PREFIX=com.amartya18.t3code
export T3CODE_EXPO_OWNER=amartya18
export T3CODE_EAS_PROJECT_ID=96c0c3a4-8096-4562-a5b4-efafb55415c6
export APP_VARIANT=preview
project_url="https://expo.dev/accounts/amartya18/projects/t3-code"

eas() { npx --yes eas-cli@27.11.0 "$@"; }

report() {
  echo "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

# Same inputs as the cloud build: eas.json's preview profile builds with the preview environment.
runtime="$(eas env:exec --non-interactive preview "npx expo-updates fingerprint:generate --platform ios" \
  | sed -n '/^{/,$p' | jq -er '.hash | select(type == "string" and test("^[0-9a-f]{40}$"))')"
echo "iOS fingerprint: $runtime"

# A queued or running build counts: it ships this fingerprint, so a second one would be waste.
build_status="$(eas build:list --platform ios --build-profile preview --runtime-version "$runtime" --limit 20 --json --non-interactive \
  | sed -n '/^\[/,$p' \
  | jq -r '[.[] | select(.status == "FINISHED" or .status == "NEW" or .status == "IN_QUEUE" or .status == "IN_PROGRESS")][0].status // empty')"

if [[ -n "$build_status" ]]; then
  echo "A preview build with this fingerprint is $build_status: publishing an OTA update."
  if [[ "$dry_run" == true ]]; then
    report "Dry run: would publish an iOS preview OTA update for runtime $runtime."
    exit 0
  fi
  update="$(eas update --channel preview --environment preview --platform ios --message "$message" --non-interactive --json \
    | sed -n '/^\[/,$p' | jq -ec '.[0] | {group, runtimeVersion}')"
  group="$(jq -r .group <<< "$update")"
  published_runtime="$(jq -r .runtimeVersion <<< "$update")"
  if [[ "$published_runtime" != "$runtime" ]]; then
    echo "::error::The update targets another runtime than $runtime, so the preview build will not load it."
    exit 1
  fi
  published="published an update"
  if [[ -z "${GITHUB_ACTIONS:-}" ]]; then published="published update [$group]($project_url/updates/$group)"; fi
  report "iOS preview: $published for runtime $runtime. Force-quit and reopen the app twice to load it."
else
  echo "No preview build has this fingerprint: starting one."
  started="Native code changed: started a new iOS preview build. Install it from the Expo dashboard (t3-code → Builds)."
  if [[ "$dry_run" == true ]]; then
    report "Dry run: $started"
    exit 0
  fi
  build_id="$(eas build --platform ios --profile preview --non-interactive --no-wait --json --message "$message" \
    | sed -n '/^\[/,$p' | jq -er '.[0].id')"
  report "$started"
  if [[ -z "${GITHUB_ACTIONS:-}" ]]; then echo "Build: $project_url/builds/$build_id"; fi
fi
