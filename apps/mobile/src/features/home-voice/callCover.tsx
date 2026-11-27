import { RegistryContext } from "@effect/atom-react";
import type { Atom, AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState, type ReactNode } from "react";

/** Whether the route sits under the open call, which covers the whole screen. */
export function coveredByCall(
  routes: ReadonlyArray<{ readonly key: string; readonly name: string }>,
  key: string,
): boolean {
  const call = routes.findIndex((route) => route.name === "VoiceCall");
  const own = routes.findIndex((route) => route.key === key);
  return call !== -1 && own !== -1 && own < call;
}

interface Hold {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly release: () => void;
}

/**
 * The registry as a covered screen sees it: atoms stay mounted and readable, but their changes
 * reach its subscribers only on release. Everything else runs on the real registry, so atoms
 * built meanwhile never hold anything themselves.
 */
export function holdRegistry(registry: AtomRegistry.AtomRegistry): Hold {
  const held = new Set<() => void>();
  function subscribe<A>(
    atom: Atom.Atom<A>,
    f: (value: A) => void,
    options?: { readonly immediate?: boolean },
  ) {
    let passThrough = options?.immediate === true;
    let latest: { readonly value: A } | null = null;
    const deliver = () => {
      if (latest !== null) f(latest.value);
    };
    const unsubscribe = registry.subscribe(
      atom,
      (value) => {
        if (passThrough) return f(value);
        latest = { value };
        held.add(deliver);
      },
      options,
    );
    passThrough = false;
    return () => {
      held.delete(deliver);
      unsubscribe();
    };
  }
  const bound = new Map<PropertyKey, unknown>();
  return {
    registry: new Proxy(registry, {
      get(target, key) {
        if (key === "subscribe") return subscribe;
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (!bound.has(key)) bound.set(key, value.bind(target));
        return bound.get(key);
      },
    }),
    release() {
      for (const deliver of held) {
        held.delete(deliver);
        deliver();
      }
    },
  };
}

/**
 * Atom changes stop reaching the screen while `held`, so it doesn't re-render under the call;
 * when uncovered, its readers re-subscribe to the live registry and catch up in one render.
 */
export function HeldRegistry(props: { readonly held: boolean; readonly children: ReactNode }) {
  const registry = useContext(RegistryContext);
  const [hold, setHold] = useState<Hold | null>(null);
  if (props.held && hold === null) setHold(holdRegistry(registry));
  if (!props.held && hold !== null) setHold(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listeners outside React that never re-subscribe still hear what changed while held
  useEffect(() => (hold === null ? undefined : hold.release), [hold]);
  return <RegistryContext value={hold?.registry ?? registry}>{props.children}</RegistryContext>;
}
