import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));

import { CopyWholeChatButton } from "./CopyWholeChatButton";

describe("CopyWholeChatButton", () => {
  it("renders an accessible enabled action with its label", () => {
    const markup = renderToStaticMarkup(
      <CopyWholeChatButton disabled={false} getTranscript={() => "transcript"} />,
    );

    expect(markup).toContain('aria-label="Copy chat"');
    expect(markup).toContain("Copy chat</span>");
    expect(markup).not.toContain('disabled=""');
  });

  it("renders a disabled action while copying is unavailable", () => {
    const markup = renderToStaticMarkup(
      <CopyWholeChatButton disabled getTranscript={() => "transcript"} />,
    );

    expect(markup).toContain('aria-label="Copy chat"');
    expect(markup).toContain('disabled=""');
  });

  it("does not build the transcript during render", () => {
    const getTranscript = vi.fn(() => "transcript");

    renderToStaticMarkup(<CopyWholeChatButton disabled={false} getTranscript={getTranscript} />);

    expect(getTranscript).not.toHaveBeenCalled();
  });
});
