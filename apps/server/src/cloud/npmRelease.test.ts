import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as NpmRelease from "./npmRelease.ts";

const RELEASES = "https://github.com/amartya18/t3code/releases";
const version = "0.1.13-nightly.20261125.31";
const manifest = JSON.stringify({ name: "t3", version, t3code: { databaseMigration: 117 } });

const makeService = (respond: (url: string) => Response | "stall") => {
  const urls: string[] = [];
  const client = HttpClient.make((request) => {
    urls.push(request.url);
    const response = respond(request.url);
    return response === "stall"
      ? Effect.never
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return NpmRelease.make().pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.map((service) => ({ service, urls })),
  );
};

it.effect.each([
  { spec: version, urls: [`${RELEASES}/download/v${version}/t3code.json`] },
  { spec: "latest", urls: [`${RELEASES}/latest/download/t3code.json`] },
  {
    spec: "nightly",
    urls: [
      `${RELEASES}/download/update-feed/nightly.json`,
      `${RELEASES}/download/v${version}/t3code.json`,
    ],
  },
])("reads $spec from the fork's release manifest", (fixture) =>
  Effect.gen(function* () {
    const { service, urls } = yield* makeService((url) =>
      url.endsWith("/nightly.json")
        ? new Response(JSON.stringify({ tag_name: `v${version}`, name: "PR #45" }))
        : new Response(manifest),
    );
    const expected = { version, databaseMigration: 117 };
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(urls).toEqual(fixture.urls);
    yield* TestClock.adjust("1 minute");
    yield* service.get({ spec: fixture.spec });
    expect(urls).toEqual([...fixture.urls, ...fixture.urls]);
  }),
);

it.effect.each(["nightly", "latest", "1.2.3"])(
  "treats a missing pointer or manifest as unpublished: %s",
  (spec) =>
    Effect.gen(function* () {
      const { service } = yield* makeService(() => new Response("Not Found", { status: 404 }));
      expect(yield* service.get({ spec })).toBeNull();
    }),
);

it.effect.each([
  { name: "a server error", spec: "1.2.3", body: () => new Response("", { status: 502 }) },
  { name: "a manifest that is not JSON", spec: "1.2.3", body: () => new Response("<html>") },
  { name: "a manifest for another version", spec: "1.2.3", body: () => new Response(manifest) },
  { name: "a pointer without a tag", spec: "nightly", body: () => new Response("{}") },
])("reports $name as a failed lookup, not an unpublished release", (fixture) =>
  Effect.gen(function* () {
    const { service } = yield* makeService(fixture.body);
    const found = yield* service.get({ spec: fixture.spec }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect("gives up on a stalled download after 15 seconds", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService(() => "stall");
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(stalled))).toBe(true);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before any request: %s",
  (spec) =>
    Effect.gen(function* () {
      const { service, urls } = yield* makeService(() => new Response(manifest));
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
      expect(urls).toEqual([]);
    }),
);
