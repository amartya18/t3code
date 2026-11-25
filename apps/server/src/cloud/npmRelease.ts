import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL, npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));
const Manifest = Schema.Struct({ version: Version, t3code: Schema.optionalKey(Schema.Unknown) });
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));
const decodePointer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ tag_name: Schema.String })),
);
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

const invalidMetadata = () =>
  new ServerNpmReleaseError({ reason: "the fork's release returned invalid metadata." });

function toRelease(spec: string, json: string) {
  const manifest = Option.getOrUndefined(decodeManifest(json));
  if (!manifest || (spec !== "latest" && spec !== "nightly" && manifest.version !== spec)) {
    return Effect.fail(invalidMetadata());
  }
  const databaseMigration = npmReleaseDatabaseMigration(manifest);
  return Effect.succeed({
    version: manifest.version,
    ...(databaseMigration === undefined ? {} : { databaseMigration }),
  });
}

// Fork: track switches read the fork's GitHub releases, not npm's `t3`, which is upstream's. Each
// fork release carries `t3code.json` (the npm launcher manifest) and `update-feed` names the newest
// nightly. See .github/workflows/fork-release.yml.
export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const download = Effect.fn("NpmRelease.download")(function* (path: string) {
    const unreachable = new ServerNpmReleaseError({
      reason: "the fork's GitHub releases could not be reached.",
    });
    return yield* Effect.gen(function* () {
      const response = yield* http.get(`${CLI_RELEASES_PAGE_URL}/${path}`);
      if (response.status === 404) return Option.none<string>();
      if (response.status < 200 || response.status >= 300) return yield* unreachable;
      return Option.some(yield* response.text);
    }).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(() => unreachable),
    );
  });
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      let manifestPath = `download/v${spec}/t3code.json`;
      if (spec === "latest") manifestPath = "latest/download/t3code.json";
      if (spec === "nightly") {
        const pointer = yield* download("download/update-feed/nightly.json");
        if (Option.isNone(pointer)) return null;
        const tag = Option.getOrUndefined(decodePointer(pointer.value))?.tag_name;
        if (tag === undefined) return yield* invalidMetadata();
        manifestPath = `download/${encodeURIComponent(tag)}/t3code.json`;
      }
      const manifest = yield* download(manifestPath);
      return Option.isNone(manifest) ? null : yield* toRelease(spec, manifest.value);
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
