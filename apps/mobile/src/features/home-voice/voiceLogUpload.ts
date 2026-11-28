import { TurboModuleRegistry, type TurboModule } from "react-native";

const VOICE_LOG_PORT = 8799;
const FLUSH_MS = 2_000;
const BATCH_LINES = 50;
const MAX_BUFFERED_LINES = 2_000;

interface VoiceLogUploader {
  readonly add: (line: string) => void;
}

function createVoiceLogUploader(options: {
  readonly url: string;
  readonly post: (url: string, body: string) => Promise<void>;
  readonly now: () => Date;
}): VoiceLogUploader {
  let pending: string[] = [];
  let posting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    timer ??= setTimeout(flush, FLUSH_MS);
  };

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (posting || pending.length === 0) return;
    const batch = pending;
    pending = [];
    posting = true;
    const settled = (failed: boolean) => {
      posting = false;
      if (failed) pending = [...batch, ...pending].slice(-MAX_BUFFERED_LINES);
      if (pending.length >= BATCH_LINES && !failed) flush();
      else if (pending.length > 0) schedule();
    };
    options.post(options.url, `${batch.join("\n")}\n`).then(
      () => settled(false),
      () => settled(true),
    );
  };

  return {
    add(line) {
      pending.push(`${options.now().toISOString()} ${line}`);
      if (pending.length > MAX_BUFFERED_LINES) pending = pending.slice(-MAX_BUFFERED_LINES);
      if (pending.length >= BATCH_LINES) flush();
      else schedule();
    },
  };
}

/** The dev machine's address, from the URL Metro served this bundle from. */
function voiceLogUrl(scriptUrl: string | null): string | null {
  const host = scriptUrl?.match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/)?.[1];
  return host === undefined ? null : `http://${host}:${VOICE_LOG_PORT}/voice-log`;
}

function bundleUrl(): string | null {
  try {
    return (
      TurboModuleRegistry.get<{ getConstants(): { scriptURL: string | null } } & TurboModule>(
        "SourceCode",
      )?.getConstants().scriptURL ?? null
    );
  } catch {
    return null;
  }
}

async function postText(url: string, body: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  if (!response.ok) throw new Error(`voice log upload ${response.status}`);
}

let uploader: VoiceLogUploader | null | undefined;

/**
 * Dev only: logs a `[voice]` line to the console and also posts it to the dev machine, which
 * keeps it when Metro's log stream from the phone drops, as it does in the background.
 */
export function voiceDevLog(line: string) {
  if (!__DEV__) return;
  console.log(line);
  if (uploader === undefined) {
    const url = voiceLogUrl(bundleUrl());
    uploader =
      url === null ? null : createVoiceLogUploader({ url, post: postText, now: () => new Date() });
  }
  uploader?.add(line);
}
