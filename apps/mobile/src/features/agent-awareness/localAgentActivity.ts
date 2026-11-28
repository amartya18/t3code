import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { makeAggregateState } from "@t3tools/shared/agentActivityAggregate";
import { isTerminalPhase } from "@t3tools/shared/agentActivityPayloads";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";

/**
 * The card a server would push for its active threads, read from the shells this phone
 * already syncs. Servers that push to APNs directly never reach the relay snapshot.
 */
export function localAgentActivityAggregate(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: Pick<OrchestrationV2ShellSnapshot, "projects" | "threads">;
  }>;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const activeStates: Array<RelayAgentActivityState> = [];
  for (const { environmentId, snapshot } of input.environments) {
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null) continue;
      // The server publishes nothing for a thread whose project is gone.
      const project = projectById.get(thread.projectId);
      if (!project) continue;
      const state = projectThreadAwarenessV2({ environmentId, project, thread });
      if (state !== null && !isTerminalPhase(state)) activeStates.push(state);
    }
  }
  return makeAggregateState({ activeStates, terminalState: null, nowMs: input.nowMs });
}
