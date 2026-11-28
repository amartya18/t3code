import { createContext, use } from "react";

/**
 * Where menus, tooltips and popovers inside it portal to, in place of the document body.
 * UI rendered into another window's document provides a container there.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | undefined {
  return use(PortalContainer) ?? undefined;
}
