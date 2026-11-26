import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { startMainAppLocationTracking, useCloseAppModal } from "./mainAppLocation";

const THREAD_PATH = "/environment-one/thread-one";

function CloseControl() {
  const closeAppModal = useCloseAppModal();
  return (
    <button type="button" onClick={() => void closeAppModal()}>
      Close modal
    </button>
  );
}

async function settled(router: AnyRouter, navigation: Promise<void>) {
  await navigation;
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

describe("Scheduled tasks page", () => {
  it("closes back to the thread it opened over, like Usage", async () => {
    await using screen = await render(<CloseControl />, { router: "/" });
    const router = screen.router!;
    await settled(router, router.navigate({ href: THREAD_PATH }));
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };

    await settled(router, router.navigate({ href: "/scheduled-tasks" }));
    await userEvent.click(screen.getByRole("button", { name: "Close modal" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
  });
});
