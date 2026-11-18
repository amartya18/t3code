import { createHomeEnvironmentAtoms, createUserHomeAtom } from "@t3tools/client-runtime/state/home";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const homeEnvironment = createHomeEnvironmentAtoms(connectionAtomRuntime);

export const userHomeAtom = createUserHomeAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  settingsValueAtom: serverEnvironment.settingsValueAtom,
});
