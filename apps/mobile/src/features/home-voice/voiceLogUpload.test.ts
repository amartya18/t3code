import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  scriptURL: "http://192.168.1.20:8081/index.bundle?platform=ios&dev=true" as string | null,
}));
vi.mock("react-native", () => ({
  TurboModuleRegistry: {
    get: (name: string) =>
      name === "SourceCode" ? { getConstants: () => ({ scriptURL: native.scriptURL }) } : null,
  },
}));

const posts: Array<{ url: string; type: string; body: string }> = [];
let failing = false;

async function load(dev: boolean) {
  vi.stubGlobal("__DEV__", dev);
  vi.resetModules();
  return import("./voiceLogUpload");
}

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T21:00:00.000Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  posts.length = 0;
  failing = false;
  native.scriptURL = "http://192.168.1.20:8081/index.bundle?platform=ios&dev=true";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (failing) throw new TypeError("Network request failed");
    posts.push({
      url,
      type: new Headers(init.headers).get("Content-Type") ?? "",
      body: String(init.body),
    });
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("in development, posts the voice log to port 8799 on the Metro host every 2 s, each line stamped", async () => {
  const { voiceDevLog } = await load(true);
  voiceDevLog("[voice] turn 1 Smart Turn 0.42 after 0.2 s silence: wait");
  vi.advanceTimersByTime(500);
  voiceDevLog("[voice] turn 1 Smart Turn 0.81 after 0.7 s silence: send");
  vi.advanceTimersByTime(1_499);
  await settle();
  expect(posts).toEqual([]);

  vi.advanceTimersByTime(1);
  await settle();
  expect(posts).toEqual([
    {
      url: "http://192.168.1.20:8799/voice-log",
      type: "text/plain",
      body:
        "2026-11-27T21:00:00.000Z [voice] turn 1 Smart Turn 0.42 after 0.2 s silence: wait\n" +
        "2026-11-27T21:00:00.500Z [voice] turn 1 Smart Turn 0.81 after 0.7 s silence: send\n",
    },
  ]);
});

it("posts at once when 50 lines are waiting", async () => {
  const { voiceDevLog } = await load(true);
  for (let line = 1; line <= 50; line++) voiceDevLog(`[voice] line ${line}`);
  await settle();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body.trimEnd().split("\n")).toHaveLength(50);
});

it("keeps a failed batch for the next post, dropping the oldest lines past 2000", async () => {
  const { voiceDevLog } = await load(true);
  failing = true;
  for (let line = 1; line <= 2_100; line++) voiceDevLog(`[voice] line ${line}`);
  await settle();
  expect(posts).toEqual([]);

  failing = false;
  vi.advanceTimersByTime(2_000);
  await settle();
  const lines = posts.flatMap((post) => post.body.trimEnd().split("\n"));
  expect(lines).toHaveLength(2_000);
  expect(lines[0]).toBe("2026-11-27T21:00:00.000Z [voice] line 101");
  expect(lines.at(-1)).toBe("2026-11-27T21:00:00.000Z [voice] line 2100");
});

it("posts nothing when the bundle did not come from Metro", async () => {
  native.scriptURL = null;
  const { voiceDevLog } = await load(true);
  voiceDevLog("[voice] stage synth.start");
  vi.advanceTimersByTime(5_000);
  await settle();
  expect(posts).toEqual([]);
});

it("in production, neither prints nor posts", async () => {
  const { voiceDevLog } = await load(false);
  for (let line = 1; line <= 60; line++) voiceDevLog(`[voice] line ${line}`);
  vi.advanceTimersByTime(5_000);
  await settle();
  expect(posts).toEqual([]);
  expect(console.log).not.toHaveBeenCalled();
});
