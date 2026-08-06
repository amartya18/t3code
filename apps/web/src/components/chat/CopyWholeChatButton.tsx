import { CheckIcon, CopyIcon } from "lucide-react";
import { memo } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const CopyWholeChatButton = memo(function CopyWholeChatButton({
  disabled,
  getTranscript,
}: {
  readonly disabled: boolean;
  readonly getTranscript: () => string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "chat transcript",
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Chat copied",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy chat",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const label = isCopied ? "Chat copied" : "Copy chat";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
            disabled={disabled || isCopied}
            onClick={() => copyToClipboard(getTranscript())}
            size="xs"
            type="button"
            variant="outline"
          />
        }
      >
        {isCopied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
