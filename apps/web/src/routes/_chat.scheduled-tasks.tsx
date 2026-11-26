import { createFileRoute } from "@tanstack/react-router";
import { useMessages } from "gt-react";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { validateSettingsRouteSearch } from "../components/settings/settingsScopeNavigation";
import { SETTINGS_SECTION_LABELS } from "../components/settings/settingsSearch";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";

// Fork-only: Settings › Scheduled tasks in the Usage page's modal. No `taskId` search, so the
// editor closes in place instead of navigating to the Settings route.
function ScheduledTasksRoute() {
  const title = useMessages()(SETTINGS_SECTION_LABELS["/settings/scheduled-tasks"]);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppRouteModal label={title}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel={title} className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>{title}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto">
            <AppRouteModalClose />
          </div>
        </header>
        <SettingsScopeProvider
          search={search}
          onChange={(next) =>
            void navigate({
              search: { project: next.project, machine: next.machine, checkout: next.checkout },
              resetScroll: false,
            })
          }
        >
          <ScheduledTasksSettings key={JSON.stringify(search)} />
        </SettingsScopeProvider>
      </div>
    </AppRouteModal>
  );
}

export const Route = createFileRoute("/_chat/scheduled-tasks")({
  validateSearch: validateSettingsRouteSearch,
  component: ScheduledTasksRoute,
});
