import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  // app.config.ts copies this into process.env, which would store an undefined as "undefined".
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    ...Object.fromEntries(
      [
        "T3CODE_APPLE_TEAM_ID",
        "T3CODE_IOS_BUNDLE_ID_PREFIX",
        "T3CODE_EXPO_OWNER",
        "T3CODE_EAS_PROJECT_ID",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("signs a fork with its own Apple team and Expo project", async () => {
  vi.stubEnv("T3CODE_APPLE_TEAM_ID", "FORKTEAM01");
  vi.stubEnv("T3CODE_IOS_BUNDLE_ID_PREFIX", "com.example.t3code");
  vi.stubEnv("T3CODE_EXPO_OWNER", "example");
  vi.stubEnv("T3CODE_EAS_PROJECT_ID", "00000000-0000-0000-0000-000000000000");
  const config = await loadConfig("development");
  expect(config.ios?.bundleIdentifier).toBe("com.example.t3code.dev");
  expect(config.ios?.appleTeamId).toBe("FORKTEAM01");
  expect(config.owner).toBe("example");
  expect(config.extra?.eas?.projectId).toBe("00000000-0000-0000-0000-000000000000");
  expect(config.updates?.url).toBe("https://u.expo.dev/00000000-0000-0000-0000-000000000000");
});

it("rejects a partial fork identity", async () => {
  vi.stubEnv("T3CODE_APPLE_TEAM_ID", "FORKTEAM01");
  await expect(loadConfig("development")).rejects.toThrow(
    "Set all of T3CODE_APPLE_TEAM_ID, T3CODE_IOS_BUNDLE_ID_PREFIX, T3CODE_EXPO_OWNER, T3CODE_EAS_PROJECT_ID for a fork build, or none.",
  );
});
