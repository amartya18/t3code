import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { SettingsScheduledTasksRouteScreen } from "../../settings/SettingsScheduledTasksRouteScreen";
import { SettingsEnvironmentFilterProvider } from "../../settings/settings-environment-filter";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { WorkflowsScreen } from "../../workflows/WorkflowsScreen";

export function WorkspaceExtraTab(props: {
  tab: Extract<NavigationTab, "usage" | "workflows" | "scheduledTasks">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "workflows" ? (
        <WorkflowsScreen />
      ) : props.tab === "scheduledTasks" ? (
        // The app-wide filter clears whenever Settings is closed, so the tab keeps its own.
        <SettingsEnvironmentFilterProvider open>
          <SettingsScheduledTasksRouteScreen workspace />
        </SettingsEnvironmentFilterProvider>
      ) : (
        <UsageRouteScreen workspace />
      )}
    </>
  );
}
