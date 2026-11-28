import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  type DiagnosticStore,
  type DiagnosticSubmitOutcome,
  type HomeSession,
  startDiagnosticUpload,
  uploadPendingDiagnostics,
} from "./diagnosticUpload";

const HOME = EnvironmentId.make("home-env");

function memoryStore(ids: ReadonlyArray<string>) {
  const files = new Map(ids.map((id) => [id, `{"id":"${id}"}`]));
  const store: DiagnosticStore = {
    pending: async () => [...files].map(([id, json]) => ({ id, json })),
    remove: async (id) => {
      files.delete(id);
    },
  };
  return { store, files };
}

function recordingSubmit(outcomes: Record<string, DiagnosticSubmitOutcome> = {}) {
  const sent: Array<{ environmentId?: string; json: string }> = [];
  const submit = async (json: string, environmentId?: string) => {
    sent.push({ environmentId, json });
    return outcomes[json] ?? "saved";
  };
  return { sent, submit };
}

describe("uploadPendingDiagnostics", () => {
  it("sends each report oldest first and removes the ones the server took", async () => {
    const { store, files } = memoryStore(["a", "b"]);
    const { sent, submit } = recordingSubmit();
    await uploadPendingDiagnostics(store, submit);
    expect(sent.map(({ json }) => json)).toEqual(['{"id":"a"}', '{"id":"b"}']);
    expect([...files.keys()]).toEqual([]);
  });

  it("keeps a report the server did not take and stops there", async () => {
    const { store, files } = memoryStore(["a", "b", "c"]);
    const { sent, submit } = recordingSubmit({ '{"id":"b"}': "failed" });
    await uploadPendingDiagnostics(store, submit);
    expect(sent.map(({ json }) => json)).toEqual(['{"id":"a"}', '{"id":"b"}']);
    expect([...files.keys()]).toEqual(["b", "c"]);
  });

  it("drops a report the server refused for good", async () => {
    const { store, files } = memoryStore(["a", "b"]);
    const { submit } = recordingSubmit({ '{"id":"a"}': "rejected" });
    await uploadPendingDiagnostics(store, submit);
    expect([...files.keys()]).toEqual([]);
  });

  it("never throws when the store or the connection does", async () => {
    const broken: DiagnosticStore = {
      pending: () => Promise.reject(new Error("unreadable")),
      remove: () => Promise.reject(new Error("unreachable")),
    };
    await expect(uploadPendingDiagnostics(broken, async () => "saved")).resolves.toBeUndefined();
    const { store, files } = memoryStore(["a"]);
    await expect(
      uploadPendingDiagnostics(store, () => Promise.reject(new Error("socket closed"))),
    ).resolves.toBeUndefined();
    expect([...files.keys()]).toEqual(["a"]);
  });
});

describe("startDiagnosticUpload", () => {
  function setup(store: DiagnosticStore | null) {
    const registry = AtomRegistry.make();
    const homeSessionAtom = Atom.make<HomeSession | null>(null);
    const { sent, submit } = recordingSubmit();
    const passes: Array<Promise<void>> = [];
    const stop = startDiagnosticUpload({
      registry,
      homeSessionAtom,
      store,
      submit: (environmentId, json) => submit(json, environmentId),
      schedule: (run) => {
        passes.push(run());
      },
    });
    const connect = async (generation: number) => {
      registry.set(homeSessionAtom, { environmentId: HOME, generation });
      await Promise.all(passes);
    };
    return { registry, homeSessionAtom, sent, stop, connect, passes };
  }

  it("waits for a session to Home's environment before sending", async () => {
    const { store, files } = memoryStore(["a"]);
    const { sent, connect, passes } = setup(store);
    await Promise.all(passes);
    expect(sent).toEqual([]);

    await connect(1);
    expect(sent).toEqual([{ environmentId: HOME, json: '{"id":"a"}' }]);
    expect([...files.keys()]).toEqual([]);
  });

  it("sends again only when a new session connects", async () => {
    const { store, files } = memoryStore(["a"]);
    const { sent, connect } = setup(store);
    await connect(1);
    files.set("b", '{"id":"b"}');
    await connect(1);
    expect(sent).toHaveLength(1);
    await connect(2);
    expect(sent.map(({ json }) => json)).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });

  it("does nothing where the native module is missing", async () => {
    const { sent, connect, passes } = setup(null);
    await connect(1);
    expect(passes).toEqual([]);
    expect(sent).toEqual([]);
  });
});
