// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLIENT_DIAGNOSTIC_MAX_BYTES,
  ClientDiagnosticSubmitError,
  type ClientDiagnosticSubmitInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

export const CLIENT_DIAGNOSTIC_FILES_KEPT = 200;

export class ClientDiagnostics extends Context.Service<
  ClientDiagnostics,
  {
    /** Saves one report as `<stateDir>/diagnostics/<received at>-<content hash>.json`. */
    readonly submit: (
      input: ClientDiagnosticSubmitInput,
    ) => Effect.Effect<void, ClientDiagnosticSubmitError>;
  }
>()("t3/diagnostics/ClientDiagnostics") {}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join((yield* ServerConfig.ServerConfig).stateDir, "diagnostics");
  const writes = yield* Semaphore.make(1);

  const save = Effect.fn("ClientDiagnostics.save")(function* (
    hash: string,
    contents: (receivedAt: string) => string,
  ) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const names = (yield* fileSystem.readDirectory(directory))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    // A client that missed the answer sends the same report again on its next launch.
    if (names.some((name) => name.endsWith(`-${hash}.json`))) return;
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const name = `${receivedAt.replaceAll(":", "-")}-${hash}.json`;
    yield* fileSystem.writeFileString(path.join(directory, name), contents(receivedAt));
    const stale = names.slice(0, Math.max(0, names.length + 1 - CLIENT_DIAGNOSTIC_FILES_KEPT));
    yield* Effect.forEach(stale, (old) => fileSystem.remove(path.join(directory, old)), {
      discard: true,
    });
  });

  const submit = Effect.fn("ClientDiagnostics.submit")(function* (
    input: ClientDiagnosticSubmitInput,
  ) {
    if (Buffer.byteLength(input.json) > CLIENT_DIAGNOSTIC_MAX_BYTES) {
      return yield* new ClientDiagnosticSubmitError({ reason: "too_large" });
    }
    const payload = parseJson(input.json);
    if (payload === undefined) {
      return yield* new ClientDiagnosticSubmitError({ reason: "invalid_json" });
    }
    const hash = NodeCrypto.createHash("sha256").update(input.json).digest("hex").slice(0, 12);
    yield* writes
      .withPermits(1)(
        save(hash, (receivedAt) => `${JSON.stringify({ receivedAt, payload }, null, 2)}\n`),
      )
      .pipe(
        Effect.mapError(
          (cause) => new ClientDiagnosticSubmitError({ reason: "write_failed", cause }),
        ),
      );
  });

  return ClientDiagnostics.of({ submit });
});

export const layer = Layer.effect(ClientDiagnostics, make);
