import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLIENT_DIAGNOSTIC_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { sampleCrashPayload } from "../testUtils/sampleCrashPayload.ts";
import * as ClientDiagnostics from "./ClientDiagnostics.ts";

const layer = ClientDiagnostics.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-diagnostics-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const savedReports = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join((yield* ServerConfig.ServerConfig).stateDir, "diagnostics");
  if (!(yield* fileSystem.exists(directory))) return [];
  const names = (yield* fileSystem.readDirectory(directory)).toSorted();
  return yield* Effect.forEach(names, (name) =>
    fileSystem
      .readFileString(path.join(directory, name))
      .pipe(Effect.map((text) => ({ name, report: JSON.parse(text) }))),
  );
});

describe("ClientDiagnostics", () => {
  it.effect("saves a crash payload as received, with when it arrived", () =>
    Effect.gen(function* () {
      const diagnostics = yield* ClientDiagnostics.ClientDiagnostics;
      yield* diagnostics.submit({ json: JSON.stringify(sampleCrashPayload) });

      const [saved, ...rest] = yield* savedReports;
      assert.deepEqual(rest, []);
      assert.match(
        saved!.name,
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{12}\.json$/u,
      );
      assert.deepEqual(saved!.report.payload, sampleCrashPayload);
      assert.isFalse(Number.isNaN(Date.parse(saved!.report.receivedAt)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps one file when a client sends the same report again", () =>
    Effect.gen(function* () {
      const diagnostics = yield* ClientDiagnostics.ClientDiagnostics;
      const json = JSON.stringify(sampleCrashPayload);
      yield* diagnostics.submit({ json });
      yield* diagnostics.submit({ json });
      assert.lengthOf(yield* savedReports, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses invalid JSON and reports over the size limit, saving nothing", () =>
    Effect.gen(function* () {
      const diagnostics = yield* ClientDiagnostics.ClientDiagnostics;
      const invalid = yield* diagnostics.submit({ json: "{not json" }).pipe(Effect.flip);
      const tooLarge = yield* diagnostics
        .submit({ json: JSON.stringify({ pad: "x".repeat(CLIENT_DIAGNOSTIC_MAX_BYTES) }) })
        .pipe(Effect.flip);
      assert.strictEqual(invalid.reason, "invalid_json");
      assert.strictEqual(tooLarge.reason, "too_large");
      assert.deepEqual(yield* savedReports, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops the oldest reports beyond the limit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join((yield* ServerConfig.ServerConfig).stateDir, "diagnostics");
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      for (let index = 0; index < ClientDiagnostics.CLIENT_DIAGNOSTIC_FILES_KEPT; index++) {
        const name = `1969-12-31T00-00-00.${String(index).padStart(3, "0")}Z-old${index}.json`;
        yield* fileSystem.writeFileString(path.join(directory, name), "{}");
      }

      const diagnostics = yield* ClientDiagnostics.ClientDiagnostics;
      yield* diagnostics.submit({ json: JSON.stringify(sampleCrashPayload) });

      const names = (yield* savedReports).map(({ name }) => name);
      assert.lengthOf(names, ClientDiagnostics.CLIENT_DIAGNOSTIC_FILES_KEPT);
      assert.notInclude(names, "1969-12-31T00-00-00.000Z-old0.json");
      assert.include(names, "1969-12-31T00-00-00.001Z-old1.json");
      assert.isFalse(names.at(-1)!.startsWith("1969-"));
    }).pipe(Effect.provide(layer)),
  );
});
