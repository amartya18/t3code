import { expect, it, vi } from "vite-plus/test";

import { applyThemeCss } from "~/themeCss";

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
  // The app's own styles, then the theme's adopted CSS (none here), then the reset.
  const appStyles = () => mirroredStyles().slice(0, -2);
  const reset = (styles: ReadonlyArray<string | null>) => styles.at(-1);

  const popup = prepare();
  expect(appStyles()).toEqual([".a { color: red; }", "/assets/app.css"]);
  expect(reset(mirroredStyles())).toContain("background: transparent");
  expect(target.documentElement.className).toBe("dark");

  // Vite injects and rewrites styles at runtime; the theme changes the root's class and style.
  theme.textContent = ".a { color: blue; }";
  const hot = appStyle(".b { color: green; }");
  link.remove();
  source.documentElement.className = "light";
  source.documentElement.style.setProperty("--background", "white");
  await vi.waitFor(() =>
    expect(appStyles()).toEqual([".a { color: blue; }", ".b { color: green; }"]),
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

it("keeps an imported or agent theme's CSS, which no element carries, ahead of the reset", () => {
  using _css = { [Symbol.dispose]: () => applyThemeCss(undefined) };
  const target = document.implementation.createHTMLDocument("");
  const ownStyles = () =>
    Array.from(target.head.querySelectorAll("style"), (style) => style.textContent);
  applyThemeCss(".theme-probe { color: red; }");

  const popup = preparePreviewWindowDocument(target, document, vi.fn());
  expect(ownStyles().at(-2)).toBe(".theme-probe { color: red; }");
  applyThemeCss(".theme-probe { color: blue; }");
  expect(ownStyles().at(-2)).toBe(".theme-probe { color: blue; }");

  popup.dispose();
  applyThemeCss(".theme-probe { color: green; }");
  expect(ownStyles().at(-2)).toBe(".theme-probe { color: blue; }");
});

it("draws the bar once the app's stylesheets load, so no control keeps the browser's default look", async () => {
  const source = document.implementation.createHTMLDocument("app");
  const sheet = URL.createObjectURL(
    new Blob(
      // The app's inputs hold their background for an age so autofill never paints them.
      ["input { background-color: transparent; transition: background-color 5000000s; }"],
      { type: "text/css" },
    ),
  );
  using _sheet = { [Symbol.dispose]: () => URL.revokeObjectURL(sheet) };
  const link = source.createElement("link");
  link.rel = "stylesheet";
  link.href = sheet;
  source.head.append(link);
  const frame = document.createElement("iframe");
  document.body.append(frame);
  using _frame = { [Symbol.dispose]: () => frame.remove() };
  const target = frame.contentDocument;
  const view = frame.contentWindow;
  if (!target || !view) throw new Error("The frame has no document");

  const popup = preparePreviewWindowDocument(target, source, vi.fn());
  const input = target.createElement("input");
  popup.root.append(input);
  // The window paints before the sheet arrives.
  view.getComputedStyle(input).backgroundColor;

  await vi.waitFor(() =>
    expect(view.getComputedStyle(input).backgroundColor).toBe("rgba(0, 0, 0, 0)"),
  );
  popup.dispose();
});
