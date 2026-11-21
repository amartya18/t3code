import { VOICE_RECORDING_LIMIT_SECONDS } from "@t3tools/client-runtime/voice-input";

import { chooseRecordingMicrophone } from "../speech/browserMicrophones";
import workletUrl from "../speech/pcmWorklet.ts?worker&url";
import { requestMicrophone } from "../speech/requestMicrophone";

const SAMPLES_PER_MS = 16;

export type MarkModeAudio = {
  /** 16 kHz mono float32 PCM bytes, as the speech endpoints take them. */
  readonly pcm: Uint8Array;
  /** Epoch milliseconds of the first sample, on the clock mark times use. */
  readonly startedAt: number;
};

/** Records the preferred microphone into memory until stopped. */
export async function startMarkModeCapture(onLimit: () => void) {
  const stream = await requestMicrophone(await chooseRecordingMicrophone());
  const context = new AudioContext();
  const chunks: Float32Array<ArrayBuffer>[] = [];
  let startedAt: number | null = null;
  let stopped: (() => void) | null = null;
  const limit = setTimeout(onLimit, VOICE_RECORDING_LIMIT_SECONDS * 1_000);
  const release = () => {
    clearTimeout(limit);
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };
  try {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, "t3-pcm-capture", { channelCount: 1 });
    node.port.onmessage = ({ data }: MessageEvent<Float32Array<ArrayBuffer> | number | string>) => {
      if (data === "stopped") stopped?.();
      else if (data === "limit") onLimit();
      else if (data instanceof Float32Array) {
        // The first chunk arrives once it fills, so its first sample is that much older.
        startedAt ??= performance.timeOrigin + performance.now() - data.length / SAMPLES_PER_MS;
        chunks.push(data);
      }
    };
    context.createMediaStreamSource(stream).connect(node);
    node.connect(context.destination);
    await context.resume();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
    node.port.postMessage("start");
    return {
      stop: async (): Promise<MarkModeAudio | null> => {
        await new Promise<void>((resolve) => {
          stopped = resolve;
          setTimeout(resolve, 5_000);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
          node.port.postMessage("stop");
        });
        node.disconnect();
        release();
        if (startedAt === null) return null;
        const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        return { pcm: new Uint8Array(samples.buffer), startedAt };
      },
      cancel: () => {
        node.disconnect();
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export type MarkModeCapture = Awaited<ReturnType<typeof startMarkModeCapture>>;
