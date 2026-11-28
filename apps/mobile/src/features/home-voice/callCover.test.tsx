import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { coveredByCall, HeldRegistry, holdRegistry } from "./callCover";

describe("coveredByCall", () => {
  const routes = [
    { key: "home", name: "Home" },
    { key: "thread", name: "Thread" },
    { key: "call", name: "VoiceCall" },
    { key: "settings", name: "VoiceSessionSettings" },
  ];

  it("covers the screens under the call, not the call or a sheet over it", () => {
    expect(coveredByCall(routes, "home")).toBe(true);
    expect(coveredByCall(routes, "thread")).toBe(true);
    expect(coveredByCall(routes, "call")).toBe(false);
    expect(coveredByCall(routes, "settings")).toBe(false);
  });

  it("covers nothing once the call is minimized", () => {
    expect(coveredByCall(routes.slice(0, 2), "thread")).toBe(false);
  });
});

describe("holdRegistry", () => {
  it("keeps a change from its listeners until release, then delivers the latest value once", () => {
    const registry = AtomRegistry.make();
    const count = Atom.make(0);
    const { registry: held, release } = holdRegistry(registry);
    const heard: number[] = [];
    held.subscribe(count, (value) => heard.push(value));

    registry.set(count, 1);
    registry.set(count, 2);
    expect(heard).toEqual([]);
    expect(held.get(count)).toBe(2);

    release();
    release();
    expect(heard).toEqual([2]);
  });

  it("drops a held change once its listener unsubscribes", () => {
    const registry = AtomRegistry.make();
    const count = Atom.make(0);
    const { registry: held, release } = holdRegistry(registry);
    const heard: number[] = [];
    const unsubscribe = held.subscribe(count, (value) => heard.push(value));
    registry.set(count, 1);
    unsubscribe();
    release();
    expect(heard).toEqual([]);
  });

  it("still answers an immediate subscription with the current value", () => {
    const registry = AtomRegistry.make();
    const count = Atom.make(5);
    const heard: number[] = [];
    holdRegistry(registry).registry.subscribe(count, (value) => heard.push(value), {
      immediate: true,
    });
    expect(heard).toEqual([5]);
  });

  it("leaves atoms first built while held updating live once the hold ends", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make(1);
    const mirror = Atom.make((get) => {
      get.subscribe(source, (value) => get.setSelf(value * 2));
      return get.once(source) * 2;
    });
    const { registry: held, release } = holdRegistry(registry);
    expect(held.get(mirror)).toBe(2);
    const unsubscribeHeld = held.subscribe(mirror, () => {});

    const heard: number[] = [];
    registry.subscribe(mirror, (value) => heard.push(value));
    unsubscribeHeld();
    release();
    registry.set(source, 2);
    expect(heard).toEqual([4]);
  });
});

describe("HeldRegistry", () => {
  const roots: Array<() => void> = [];
  afterEach(() => {
    for (const unmount of roots.splice(0)) act(unmount);
  });

  it("stops a held screen re-rendering on atom changes, then catches it up when uncovered", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const registry = AtomRegistry.make();
    const count = Atom.make(0);
    let renders = 0;
    function Reader() {
      renders += 1;
      return <span>{useAtomValue(count)}</span>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(() => root.unmount());
    const show = (held: boolean) =>
      act(() =>
        root.render(
          <RegistryContext value={registry}>
            <HeldRegistry held={held}>
              <Reader />
            </HeldRegistry>
          </RegistryContext>,
        ),
      );

    show(true);
    const rendersWhileCovered = renders;
    act(() => registry.set(count, 1));
    act(() => registry.set(count, 2));
    expect(renders).toBe(rendersWhileCovered);
    expect(container.textContent).toBe("0");

    show(false);
    expect(container.textContent).toBe("2");
    act(() => registry.set(count, 3));
    expect(container.textContent).toBe("3");
  });
});
