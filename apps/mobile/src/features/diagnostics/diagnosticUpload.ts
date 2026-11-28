import type { EnvironmentId } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

export interface PendingDiagnostic {
  readonly id: string;
  readonly json: string;
}

/** The native T3Diagnostics module: reports MetricKit handed the app, kept until removed. */
export interface DiagnosticStore {
  readonly pending: () => Promise<ReadonlyArray<PendingDiagnostic>>;
  readonly remove: (id: string) => Promise<void>;
}

/** `rejected`: the server refused this report for good, so sending it again cannot help. */
export type DiagnosticSubmitOutcome = "saved" | "rejected" | "failed";

export interface HomeSession {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
}

/** Sends each stored report oldest first and stops at the first one the server did not take. */
export async function uploadPendingDiagnostics(
  store: DiagnosticStore,
  submit: (json: string) => Promise<DiagnosticSubmitOutcome>,
): Promise<void> {
  try {
    for (const { id, json } of await store.pending()) {
      if ((await submit(json)) === "failed") return;
      await store.remove(id);
    }
  } catch {
    // Whatever is left stays on the device for the next connection.
  }
}

const whenIdle = (run: () => Promise<void>) => {
  const start = () => void run();
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback(start, { timeout: 10_000 });
  } else {
    setTimeout(start, 0);
  }
};

/** Uploads once each time a new session to Home's environment connects. */
export function startDiagnosticUpload(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly homeSessionAtom: Atom.Atom<HomeSession | null>;
  readonly store: DiagnosticStore | null;
  readonly submit: (environmentId: EnvironmentId, json: string) => Promise<DiagnosticSubmitOutcome>;
  readonly schedule?: (run: () => Promise<void>) => void;
}): () => void {
  const { store } = input;
  if (store === null) return () => undefined;
  const schedule = input.schedule ?? whenIdle;
  let uploaded: HomeSession | null = null;
  return input.registry.subscribe(
    input.homeSessionAtom,
    (session) => {
      if (session === null) return;
      if (
        uploaded?.environmentId === session.environmentId &&
        uploaded.generation === session.generation
      ) {
        return;
      }
      uploaded = session;
      // Passes can overlap after a quick reconnect; the server keeps one copy of each report.
      schedule(() =>
        uploadPendingDiagnostics(store, (json) => input.submit(session.environmentId, json)),
      );
    },
    { immediate: true },
  );
}
