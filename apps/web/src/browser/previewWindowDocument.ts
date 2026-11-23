import { DESKTOP_PREVIEW_WINDOW_BAR_HEIGHT } from "@t3tools/contracts";

import { subscribeToThemeCss } from "~/themeCss";

const STYLE_SELECTOR = 'style, link[rel~="stylesheet"]';

export interface PreviewWindowDocument {
  /** The browser bar renders here. */
  readonly root: HTMLElement;
  /** Menus and tooltips portal here, so the desktop can lift the bar over the page for them. */
  readonly overlays: HTMLElement;
  readonly dispose: () => void;
}

function syncAttributes(from: Element, to: Element): void {
  for (const name of to.getAttributeNames()) {
    if (!from.hasAttribute(name)) to.removeAttribute(name);
  }
  for (const name of from.getAttributeNames()) {
    const value = from.getAttribute(name) ?? "";
    if (to.getAttribute(name) !== value) to.setAttribute(name, value);
  }
}

/**
 * Prepares a popup the app opened for a preview tab's own window: the app's stylesheets and
 * theme, kept in sync as Vite and the theme change them, and the elements the bar renders into.
 * `onOverlayChange` reports whether a menu or tooltip is open.
 */
export function preparePreviewWindowDocument(
  target: Document,
  source: Document,
  onOverlayChange: (open: boolean) => void,
): PreviewWindowDocument {
  const base = target.createElement("base");
  base.href = source.baseURI;
  const reset = target.createElement("style");
  // The page shows through wherever the bar has nothing to draw.
  reset.textContent =
    "html, body { margin: 0; overflow: hidden; background: transparent !important; }";
  target.head.replaceChildren(base, reset);

  // Imported and agent themes are adopted sheets, which no element carries. Their rules come
  // already stripped of anything that fetches.
  const adopted = target.createElement("style");
  const syncAdopted = () => {
    const css = source.adoptedStyleSheets
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join("\n");
    if (adopted.textContent !== css) adopted.textContent = css;
  };

  const clones = new Map<Element, Element>();
  const syncStyles = () => {
    const originals = Array.from(source.head.querySelectorAll(STYLE_SELECTOR));
    const live = new Set(originals);
    for (const [original, clone] of clones) {
      if (live.has(original)) continue;
      clone.remove();
      clones.delete(original);
    }
    // Cascade order follows the app's, ahead of the reset.
    let previous: Element = base;
    for (const original of originals) {
      let clone = clones.get(original);
      if (!clone) {
        clone = target.importNode(original, true);
        clones.set(original, clone);
      } else if (clone.textContent !== original.textContent) {
        clone.textContent = original.textContent;
      }
      if (previous.nextElementSibling !== clone) previous.after(clone);
      previous = clone;
    }
    // Adopted sheets order after the document's own.
    if (previous.nextElementSibling !== adopted) previous.after(adopted);
  };
  const syncRoot = () => syncAttributes(source.documentElement, target.documentElement);
  syncStyles();
  syncAdopted();
  syncRoot();

  const root = target.createElement("div");
  root.style.height = `${DESKTOP_PREVIEW_WINDOW_BAR_HEIGHT}px`;
  const overlays = target.createElement("div");
  target.body.replaceChildren(root, overlays);

  let overlayOpen = false;
  const syncOverlay = () => {
    const open = overlays.childElementCount > 0;
    if (open === overlayOpen) return;
    overlayOpen = open;
    onOverlayChange(open);
  };

  const styleObserver = new MutationObserver(syncStyles);
  styleObserver.observe(source.head, { childList: true, subtree: true, characterData: true });
  const rootObserver = new MutationObserver(syncRoot);
  rootObserver.observe(source.documentElement, { attributes: true });
  const overlayObserver = new MutationObserver(syncOverlay);
  overlayObserver.observe(overlays, { childList: true });
  const unsubscribeTheme = subscribeToThemeCss(syncAdopted);

  return {
    root,
    overlays,
    dispose: () => {
      styleObserver.disconnect();
      rootObserver.disconnect();
      overlayObserver.disconnect();
      unsubscribeTheme();
    },
  };
}
