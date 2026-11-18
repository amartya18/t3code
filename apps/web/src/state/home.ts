import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createHomeEnvironmentAtoms, createUserHomeAtom } from "@t3tools/client-runtime/state/home";
import { isHomeProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const homeEnvironment = createHomeEnvironmentAtoms(connectionAtomRuntime);

export const userHomeAtom = createUserHomeAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  settingsValueAtom: serverEnvironment.settingsValueAtom,
});

let previousRoots: ReadonlyMap<EnvironmentId, string> = new Map();
/** Each environment's Home folder. It belongs to Home alone, so pickers skip it. */
export const homeWorkspaceRootsAtom = Atom.make((get) => {
  const next = new Map<EnvironmentId, string>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const root = get(serverEnvironment.configValueAtom(environmentId))?.homeWorkspaceRoot;
    if (root !== undefined) next.set(environmentId, root);
  }
  const unchanged =
    next.size === previousRoots.size &&
    [...next].every(([environmentId, root]) => previousRoots.get(environmentId) === root);
  if (!unchanged) previousRoots = next;
  return previousRoots;
}).pipe(Atom.withLabel("web-home-workspace-roots"));

export const isProjectInHomeFolder = (
  roots: ReadonlyMap<EnvironmentId, string>,
  project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string },
) => isHomeProject(project, roots.get(project.environmentId));
