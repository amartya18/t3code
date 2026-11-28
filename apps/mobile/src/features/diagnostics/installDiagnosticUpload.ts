import { ClientDiagnosticSubmitError } from "@t3tools/contracts";
import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { userHomeAtom } from "../../state/home";
import { serverEnvironment } from "../../state/server";
import { type DiagnosticStore, type HomeSession, startDiagnosticUpload } from "./diagnosticUpload";

const isSubmitError = Schema.is(ClientDiagnosticSubmitError);

const homeSessionAtom = Atom.make((get): HomeSession | null => {
  const environmentId = userHomeThreadRef(get(userHomeAtom))?.environmentId;
  if (environmentId === undefined) return null;
  const generation = get(environmentCatalog.sessionGenerationAtom(environmentId));
  return generation === 0 ? null : { environmentId, generation };
}).pipe(Atom.withLabel("diagnostics:home-session"));

/** Sends iOS crash and diagnostic reports to Home's server over the app's own connection. */
export function installDiagnosticUpload(): () => void {
  return startDiagnosticUpload({
    registry: appAtomRegistry,
    homeSessionAtom,
    store: requireOptionalNativeModule<DiagnosticStore>("T3Diagnostics"),
    submit: async (environmentId, json) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.submitClientDiagnostic,
        { environmentId, input: { json } },
        { reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Success") return "saved";
      const error = squashAtomCommandFailure(result);
      return isSubmitError(error) && error.reason !== "write_failed" ? "rejected" : "failed";
    },
  });
}
