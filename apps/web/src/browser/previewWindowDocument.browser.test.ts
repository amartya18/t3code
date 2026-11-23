import { expect, it, vi } from "vite-plus/test";

import { preparePreviewWindowDocument } from "./previewWindowDocument";

function setup() {
  const source = document.implementation.createHTMLDocument("app");
  const target = document.implementation.createHTMLDocument("");
  const overlay = vi.fn<(open: boolean) => void>();
  const appStyle = (css: string) => {
    const style = source.createElement("style");
    style.textContent = css;
    source.head.append(style);
    return style;
  };
  const mirroredStyles = () =>
    Array.from(target.head.querySelectorAll("style, link"), (node) =>
      node.tagName === "LINK" ? node.getAttribute("href") : node.textContent,
    );
  const prepare = () => preparePreviewWindowDocument(target, source, overlay);
  return { source, target, overlay, appStyle, mirroredStyles, prepare };
}

it("keeps the app's styles and theme in the window's document, ahead of its reset", async () => {
  const { source, target, appStyle, mirroredStyles, prepare } = setup();
  const theme = appStyle(".a { color: red; }");
  const link = source.createElement("link");
  link.rel = "stylesheet";
  link.href = "/assets/app.css";
  source.head.append(link);
  source.documentElement.className = "dark";
  const reset = (styles: ReadonlyArray<string | null>) => styles.at(-1);

  const popup = prepare();
  expect(mirroredStyles().slice(0, -1)).toEqual([".a { color: red; }", "/assets/app.css"]);
  expect(reset(mirroredStyles())).toContain("background: transparent");
  expect(target.documentElement.className).toBe("dark");

  // Vite injects and rewrites styles at runtime; the theme changes the root's class and style.
  theme.textContent = ".a { color: blue; }";
  const hot = appStyle(".b { color: green; }");
  link.remove();
  source.documentElement.className = "light";
  source.documentElement.style.setProperty("--background", "white");
  await vi.waitFor(() =>
    expect(mirroredStyles().slice(0, -1)).toEqual([".a { color: blue; }", ".b { color: green; }"]),
  );
  expect(reset(mirroredStyles())).toContain("background: transparent");
  expect(target.documentElement.className).toBe("light");
  expect(target.documentElement.style.getPropertyValue("--background")).toBe("white");

  popup.dispose();
  hot.textContent = ".b { color: black; }";
  await Promise.resolve();
  expect(mirroredStyles()).toContain(".b { color: green; }");
});

it("reports a menu or tooltip open while one is portaled into the window", async () => {
  const { overlay, prepare } = setup();
  const popup = prepare();

  const menu = popup.overlays.ownerDocument.createElement("div");
  popup.overlays.append(menu);
  await vi.waitFor(() => expect(overlay).toHaveBeenLastCalledWith(true));
  // A tooltip handing over to a menu keeps the bar over the page.
  popup.overlays.append(popup.overlays.ownerDocument.createElement("div"));
  menu.remove();
  await Promise.resolve();
  expect(overlay).toHaveBeenCalledTimes(1);
  popup.overlays.replaceChildren();
  await vi.waitFor(() => expect(overlay).toHaveBeenLastCalledWith(false));
  expect(overlay).toHaveBeenCalledTimes(2);
  popup.dispose();
});
