import {
  type EnvironmentId,
  type ServerSettings,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopeThreadRef } from "../environment/scoped.ts";
import { request, requestGuarded } from "../rpc/client.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

export interface HomeFolderFile {
  readonly relativePath: string;
  readonly contents: string;
}

export interface HomeFolderSnapshot {
  readonly files: ReadonlyArray<HomeFolderFile>;
  /** Files a move leaves behind: too large to read whole, or unreadable as text. */
  readonly skipped: ReadonlyArray<string>;
}

// Claude's import file is the same everywhere; the new host writes its own.
const NOT_COPIED = new Set(["CLAUDE.md"]);

/** Reads Home's notes and instructions, so a move can bring them along. */
const readHomeFolder = Effect.fn("home.readFolder")(function* (input: { readonly cwd: string }) {
  const files: Array<HomeFolderFile> = [];
  const skipped: Array<string> = [];
  const pending: Array<string | undefined> = [undefined];
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    const listing = yield* request(WS_METHODS.projectsListEntries, {
      cwd: input.cwd,
      ...(directoryPath === undefined ? {} : { directoryPath }),
    });
    for (const entry of listing.entries) {
      if (entry.kind === "directory") {
        pending.push(entry.path);
        continue;
      }
      if (NOT_COPIED.has(entry.path)) continue;
      const read = yield* request(WS_METHODS.projectsReadFile, {
        cwd: input.cwd,
        relativePath: entry.path,
      }).pipe(Effect.option);
      if (read._tag === "None" || read.value.truncated) skipped.push(entry.path);
      else files.push({ relativePath: entry.path, contents: read.value.contents });
    }
  }
  return { files, skipped } satisfies HomeFolderSnapshot;
});

/** Turns Home on, off, or fresh on the environment that hosts it. */
export function createHomeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    enable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:enable",
      tag: WS_METHODS.homeEnable,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    disable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:disable",
      tag: WS_METHODS.homeDisable,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    startFresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:start-fresh",
      tag: WS_METHODS.homeStartFresh,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    readFolder: createEnvironmentCommand(runtime, {
      label: "environment-data:home:read-folder",
      execute: readHomeFolder,
    }),
    writeFolder: createEnvironmentCommand(runtime, {
      label: "environment-data:home:write-folder",
      execute: (input: { readonly cwd: string; readonly files: ReadonlyArray<HomeFolderFile> }) =>
        Effect.forEach(
          input.files,
          (file) =>
            requestGuarded(WS_METHODS.projectsWriteFile, {
              cwd: input.cwd,
              relativePath: file.relativePath,
              contents: file.contents,
            }),
          { discard: true },
        ),
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}

export interface HomeHost {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * The user's one Home. Each server only knows its own Home, so two hosts can
 * both be on after a failed move; clients show that instead of picking one.
 */
export type UserHome =
  | { readonly kind: "off" }
  | ({ readonly kind: "on" } & HomeHost)
  | { readonly kind: "conflict"; readonly hosts: ReadonlyArray<HomeHost> };

const OFF: UserHome = { kind: "off" };

function resolveUserHome(hosts: ReadonlyArray<HomeHost>): UserHome {
  const [first, ...rest] = hosts;
  if (first === undefined) return OFF;
  if (rest.length === 0) return { kind: "on", ...first };
  return { kind: "conflict", hosts };
}

/** The Home thread to open. With Home on in two places, the first one found. */
export function userHomeThreadRef(home: UserHome) {
  const host = home.kind === "on" ? home : home.kind === "conflict" ? home.hosts[0] : undefined;
  return host === undefined ? null : scopeThreadRef(host.environmentId, host.threadId);
}

const sameHome = (left: UserHome, right: UserHome) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Finds the user's Home across every enabled environment's settings. */
export function createUserHomeAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly settingsValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerSettings | null>;
}) {
  let previous = OFF;
  return Atom.make((get) => {
    const hosts: Array<HomeHost> = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const threadId = get(input.settingsValueAtom(environmentId))?.home.threadId ?? null;
      if (threadId !== null) hosts.push({ environmentId, threadId });
    }
    const next = resolveUserHome(hosts);
    if (!sameHome(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-data:home:user-home"));
}
