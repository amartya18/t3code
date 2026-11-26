import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import {
  activeCustomModeSkill,
  type CustomModeSkillName,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** A new task has no thread to hold its mode yet, so the mode waits here for the launch. */
const draftCustomModeAtom = Atom.family((_draftKey: string) =>
  Atom.make<CustomModeSkillName | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:draft-custom-mode"),
  ),
);
const NO_DRAFT_CUSTOM_MODE_ATOM = Atom.make<CustomModeSkillName | null>(null);
const NO_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null);

const selectActiveSkill = (thread: EnvironmentThread | null) =>
  activeCustomModeSkill(thread?.projection.thread.customMode);

/** The creation field that starts a new task's thread in its mode. */
export function draftCustomModeCreation(draftKey: string | null): {
  readonly customMode?: CustomModeSkillName;
} {
  const skill = draftKey === null ? null : appAtomRegistry.get(draftCustomModeAtom(draftKey));
  return skill === null ? {} : { customMode: skill };
}

export function useComposerCustomMode(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** A new task keeps its mode in the draft until the launch creates the thread. */
  readonly isDraft: boolean;
  readonly draftKey: string;
}): {
  readonly skill: CustomModeSkillName | null;
  readonly setSkill: (skill: CustomModeSkillName | null) => void;
} {
  const draftSkill = useAtomValue(
    input.isDraft ? draftCustomModeAtom(input.draftKey) : NO_DRAFT_CUSTOM_MODE_ATOM,
  );
  const threadSkill = useAtomValue(
    input.isDraft
      ? NO_THREAD_ATOM
      : environmentThreadDetails.threadAtom({
          environmentId: input.environmentId,
          threadId: input.threadId,
        }),
    selectActiveSkill,
  );
  const setThreadCustomMode = useAtomCommand(threadEnvironment.setCustomMode, "set custom mode");
  const setSkill = (skill: CustomModeSkillName | null) => {
    if (input.isDraft) {
      appAtomRegistry.set(draftCustomModeAtom(input.draftKey), skill);
      return;
    }
    void setThreadCustomMode({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, skill },
    });
  };
  return { skill: input.isDraft ? draftSkill : threadSkill, setSkill };
}
