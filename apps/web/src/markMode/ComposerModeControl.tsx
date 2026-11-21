import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { type PointerEvent, useState } from "react";

import { Button } from "../components/ui/button";
import { Group } from "../components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../components/ui/menu";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { type ComposerMode, useComposerModes } from "./composerModes";

type Variant = "icon" | "picker" | "pill";

// Dev-only switch between the three designs under review; production always shows "icon".
const VARIANT_STORAGE_KEY = "t3code:dev:composer-mode-control";

function readVariant(): Variant {
  if (!import.meta.env.DEV) return "icon";
  try {
    const stored = localStorage.getItem(VARIANT_STORAGE_KEY);
    return stored === "picker" || stored === "pill" ? stored : "icon";
  } catch {
    return "icon";
  }
}

// Keeps the composer's caret where it was, as the dictation button does.
const keepFocus = (event: PointerEvent) => event.preventDefault();

function ModeToggle({ mode, pill }: { readonly mode: ComposerMode; readonly pill: boolean }) {
  const Icon = mode.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant={pill ? "pill" : "ghost"}
            size={pill ? "xs" : "sm"}
            pressed={mode.active}
            onPressedChange={mode.toggle}
            disabled={mode.busy}
            aria-label={mode.label}
            onPointerDown={keepFocus}
          >
            <Icon />
            {pill ? <span>{mode.shortLabel}</span> : null}
          </Toggle>
        }
      />
      <TooltipPopup side="top">
        {mode.label}
        {mode.shortcut ? ` (${mode.shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Fork-only: the composer's mode buttons, beside send. Shows nothing where no mode works. */
export function ComposerModeControl() {
  const gt = useGT();
  const modes = useComposerModes();
  const [variant] = useState(readVariant);
  const [first] = modes;
  if (!first) return null;

  if (variant === "picker") {
    const current = modes.find((mode) => mode.active) ?? first;
    return (
      <Group aria-label={gt("Composer modes")}>
        <ModeToggle mode={current} pill={false} />
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Choose a mode")}
              />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup side="top" align="end">
            {modes.map((mode) => {
              const Icon = mode.icon;
              return (
                <MenuItem key={mode.id} disabled={mode.busy} onClick={mode.toggle}>
                  <Icon />
                  {mode.label}
                  {mode.shortcut ? <MenuShortcut>{mode.shortcut}</MenuShortcut> : null}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      </Group>
    );
  }

  return (
    <Group aria-label={gt("Composer modes")}>
      {modes.map((mode) => (
        <ModeToggle key={mode.id} mode={mode} pill={variant === "pill"} />
      ))}
    </Group>
  );
}
