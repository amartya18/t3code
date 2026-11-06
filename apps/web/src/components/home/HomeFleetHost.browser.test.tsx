import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type FleetHostRequest } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { HomeRelay } from "./HomeFleetHost";

const hub = EnvironmentId.make("environment-hub");
const other = EnvironmentId.make("environment-other");

const mocks = vi.hoisted(() => ({
  state: {} as {
    connected: boolean;
    requests: unknown;
    invoke: () => Promise<unknown>;
    respond: () => Promise<unknown>;
    relayRequests: (target: unknown) => void;
  },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment-other",
        label: "Other",
        connection: { phase: mocks.state.connected ? "connected" : "reconnecting" },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("../../state/home", () => ({
  homeEnvironment: {
    invoke: "invoke",
    relayRespond: "respond",
    relayRequests: (target: unknown) => {
      mocks.state.relayRequests(target);
      return mocks.state.requests;
    },
  },
  liveShellEnvironmentIdsAtom: null,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "invoke" ? mocks.state.invoke : mocks.state.respond,
}));

function setup() {
  const requests = Atom.make<AsyncResult.AsyncResult<FleetHostRequest, never>>(
    AsyncResult.initial(),
  );
  Object.assign(mocks.state, {
    connected: true,
    requests,
    invoke: vi.fn(async () => ({ _tag: "Success", value: {} })),
    respond: vi.fn(async () => ({ _tag: "Success", value: undefined })),
    relayRequests: vi.fn(),
  });
  return { registry: AtomRegistry.make(), requests };
}

const relay = (registry: AtomRegistry.AtomRegistry) => (
  <RegistryContext.Provider value={registry}>
    <HomeRelay environmentId={hub} />
  </RegistryContext.Provider>
);

it("runs a request once when a new registration sees it again", async () => {
  const { registry, requests } = setup();
  await using screen = await render(relay(registry), { router: false }); // no routes in the relay

  registry.set(
    requests,
    AsyncResult.success({
      requestId: "request-1",
      environmentId: other,
      invoke: {},
    } as unknown as FleetHostRequest),
  );
  await vi.waitFor(() => expect(mocks.state.respond).toHaveBeenCalledTimes(1));

  mocks.state.connected = false;
  await screen.rerender(relay(registry));
  await vi.waitFor(() =>
    expect(mocks.state.relayRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          environments: [expect.objectContaining({ connected: false })],
        }),
      }),
    ),
  );

  expect(mocks.state.invoke).toHaveBeenCalledTimes(1);
});
