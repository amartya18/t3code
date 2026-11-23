import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { T, useGT } from "gt-react";
import { AppWindow } from "lucide-react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";

import { previewBridge } from "./previewBridge";

/** Opening an open window focuses it, so `open` also serves as "Focus". */
export function usePreviewWindowActions(runtimeTabId: string | null) {
  const gt = useGT();
  const run = (operation: "open" | "close") => {
    if (!previewBridge || !runtimeTabId) return;
    void previewBridge.window[operation](runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title:
          operation === "open"
            ? gt("Unable to open preview window")
            : gt("Unable to bring preview back"),
        description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
      });
    });
  };
  return { open: () => run("open"), close: () => run("close") };
}

export function PreviewWindowPlaceholder(props: {
  readonly runtimeTabId: string;
  readonly className?: string;
}) {
  const { open, close } = usePreviewWindowActions(props.runtimeTabId);
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 bg-background p-4 text-center",
        props.className,
      )}
    >
      <AppWindow className="size-6 text-muted-foreground/70" />
      <p className="text-sm text-muted-foreground">
        <T>This page is open in its own window.</T>
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={open}>
          <T context="bring a window to the front">Focus</T>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          <T>Bring back</T>
        </Button>
      </div>
    </div>
  );
}
