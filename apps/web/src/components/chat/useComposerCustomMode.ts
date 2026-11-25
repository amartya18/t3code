import {
  activeCustomModeSkill,
  type CustomModeSkillName,
  type EnvironmentId,
  type ThreadCustomMode,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/** A draft has no thread to hold its mode yet, so the mode waits here for the launch. */
const useDraftCustomModes = create<Readonly<Record<DraftId, CustomModeSkillName>>>(() => ({}));

/** The launch field that starts a draft's thread in its mode. */
export function draftCustomModeLaunch(draftId: DraftId | null): {
  readonly customMode?: CustomModeSkillName;
} {
  const skill = draftId === null ? undefined : useDraftCustomModes.getState()[draftId];
  return skill === undefined ? {} : { customMode: skill };
}

export function useComposerCustomMode(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Undefined while the thread is still a draft. */
  readonly serverCustomMode: ThreadCustomMode | null | undefined;
  readonly isServerThread: boolean;
  readonly draftId: DraftId | null;
}): {
  readonly skill: CustomModeSkillName | null;
  readonly setSkill: (skill: CustomModeSkillName | null) => void;
} {
  const { draftId } = input;
  const draftSkill = useDraftCustomModes((modes) =>
    draftId === null ? undefined : modes[draftId],
  );
  const setThreadCustomMode = useOrchestrationCommand(threadEnvironment.setCustomMode);
  const setSkill = useStableCallback((skill: CustomModeSkillName | null) => {
    if (input.isServerThread) {
      void setThreadCustomMode({
        environmentId: input.environmentId,
        input: { threadId: input.threadId, skill },
      });
      return;
    }
    if (draftId === null) return;
    useDraftCustomModes.setState((modes) => {
      const next = { ...modes };
      if (skill === null) delete next[draftId];
      else next[draftId] = skill;
      return next;
    }, true);
  });
  return {
    skill: input.isServerThread
      ? activeCustomModeSkill(input.serverCustomMode)
      : (draftSkill ?? null),
    setSkill,
  };
}
