// @effect-diagnostics nodeBuiltinImport:off -- APNs requires HTTP/2, which Effect's HttpClient and Node's fetch do not guarantee.
import * as NodeHttp2 from "node:http2";

import { makeApnsProviderTokenCache } from "@t3tools/shared/apnsProviderToken";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { DirectApnsRequest, DirectPushDevice } from "./directAgentActivityPolicy.ts";

const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
const APNS_SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com";
const APNS_REQUEST_TIMEOUT = "10 seconds";

const KEY_ID_ENV = "T3CODE_APNS_KEY_ID";
const TEAM_ID_ENV = "T3CODE_APNS_TEAM_ID";
const PRIVATE_KEY_PATH_ENV = "T3CODE_APNS_PRIVATE_KEY_PATH";
const KEY_ID_SECRET = "apns-key-id";
const TEAM_ID_SECRET = "apns-team-id";
const PRIVATE_KEY_SECRET = "apns-private-key";

const PERMANENT_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export interface ApnsHttp2Request {
  readonly origin: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApnsHttp2Response {
  readonly status: number;
  readonly body: string;
}

export class DirectApnsTransportError extends Schema.TaggedError<DirectApnsTransportError>()(
  "DirectApnsTransportError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "APNs request failed.";
  }
}

export class DirectApnsTransport extends Context.Service<
  DirectApnsTransport,
  {
    readonly post: (
      request: ApnsHttp2Request,
    ) => Effect.Effect<ApnsHttp2Response, DirectApnsTransportError>;
  }
>()("t3/relay/DirectApnsClient/DirectApnsTransport") {}

export type DirectApnsSendResult =
  | { readonly outcome: "sent" }
  | { readonly outcome: "unconfigured" }
  | {
      readonly outcome: "rejected";
      readonly status: number;
      readonly reason: string | undefined;
      /** The token is permanently dead and must not be tried again. */
      readonly removeToken: boolean;
    }
  | { readonly outcome: "error"; readonly removeToken: false };

export class DirectApnsClient extends Context.Service<
  DirectApnsClient,
  {
    readonly isConfigured: Effect.Effect<boolean>;
    readonly send: (input: {
      readonly device: DirectPushDevice;
      readonly request: DirectApnsRequest;
    }) => Effect.Effect<DirectApnsSendResult>;
  }
>()("t3/relay/DirectApnsClient") {}

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.optional(Schema.String) })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const reasonFromBody = (body: string): string | undefined =>
  Option.getOrUndefined(decodeErrorBody(body))?.reason;

export const makeNodeHttp2Transport = Effect.gen(function* () {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  // One long-lived session per APNs host: Apple asks providers to keep
  // connections open rather than reconnecting for every push.
  const sessionFor = (origin: string) => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = NodeHttp2.connect(origin);
    session.unref();
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    // Request-level errors reach the caller through the stream; this only
    // keeps a dead session from being reused.
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", () => {
      forget();
      session.close();
    });
    sessions.set(origin, session);
    return session;
  };

  return DirectApnsTransport.of({
    post: Effect.fn("DirectApnsTransport.post")((request) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<ApnsHttp2Response>((resolve, reject) => {
            const session = sessionFor(request.origin);
            const stream = session.request({
              ":method": "POST",
              ":path": request.path,
              ...request.headers,
            });
            const chunks: Buffer[] = [];
            let status = 0;
            // A connection left dead by sleep or a network change never reports it, so a
            // timed-out or failed request drops the connection and the next push reconnects.
            const dropSession = () => session.destroy();
            signal.addEventListener("abort", dropSession);
            stream.on("error", dropSession);
            stream.on("response", (headers) => {
              status = Number(headers[":status"] ?? 0);
            });
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () =>
              resolve({ status, body: Buffer.concat(chunks).toString("utf8") }),
            );
            stream.on("error", reject);
            stream.end(request.body);
          }),
        catch: (cause) => new DirectApnsTransportError({ cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: APNS_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(new DirectApnsTransportError({ cause: "APNs request timed out" })),
        }),
      ),
    ),
  });
});

export const transportLayer = Layer.effect(DirectApnsTransport, makeNodeHttp2Transport);

const make = Effect.gen(function* () {
  const transport = yield* DirectApnsTransport;
  const fileSystem = yield* FileSystem.FileSystem;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const configProvider = yield* ConfigProvider.ConfigProvider;
  const providerTokens = makeApnsProviderTokenCache();

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const readConfig = (name: string) =>
    Config.String(name).pipe(
      Config.option,
      // The send path runs outside the layer's context, so pin the provider it was built with.
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.map(Option.filter((value) => value.trim().length > 0)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const readPrivateKey = Effect.gen(function* () {
    const path = yield* readConfig(PRIVATE_KEY_PATH_ENV);
    if (Option.isNone(path)) return yield* readSecret(PRIVATE_KEY_SECRET);
    // An unreadable key file is a misconfiguration, never a reason to fail a thread.
    return yield* fileSystem.readFileString(path.value).pipe(
      Effect.asSome,
      Effect.tapError(() =>
        Effect.logWarning("direct APNs key file could not be read", {
          envVar: PRIVATE_KEY_PATH_ENV,
        }),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

  const readCredentials = Effect.gen(function* () {
    const keyId = yield* readConfig(KEY_ID_ENV);
    const teamId = yield* readConfig(TEAM_ID_ENV);
    const privateKey = yield* readPrivateKey;
    return Option.all({
      keyId: Option.isSome(keyId) ? keyId : yield* readSecret(KEY_ID_SECRET),
      teamId: Option.isSome(teamId) ? teamId : yield* readSecret(TEAM_ID_SECRET),
      privateKey,
    });
  });

  const send: DirectApnsClient["Service"]["send"] = Effect.fn("DirectApnsClient.send")(function* ({
    device,
    request,
  }) {
    const credentials = yield* readCredentials;
    if (Option.isNone(credentials)) {
      yield* Effect.logDebug("direct APNs push skipped; credentials not configured");
      return { outcome: "unconfigured" } as const;
    }
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const jwt = yield* Effect.try({
      try: () => providerTokens.getJwt(credentials.value, nowSeconds),
      catch: (cause) => new DirectApnsTransportError({ cause }),
    }).pipe(Effect.option);
    if (Option.isNone(jwt)) {
      yield* Effect.logWarning("direct APNs provider token could not be signed; check the .p8 key");
      return { outcome: "error", removeToken: false } as const;
    }
    const response = yield* transport
      .post({
        // The token's own environment decides the host: a dev build and a
        // store build can both be registered with one server.
        origin:
          device.apsEnvironment === "production" ? APNS_PRODUCTION_ORIGIN : APNS_SANDBOX_ORIGIN,
        path: `/3/device/${request.token}`,
        headers: {
          authorization: `bearer ${jwt.value}`,
          "apns-push-type": request.pushType,
          "apns-topic":
            request.pushType === "liveactivity"
              ? `${device.bundleId}.push-type.liveactivity`
              : device.bundleId,
          "apns-priority": request.priority,
          "content-type": "application/json",
        },
        body: encodeJson(request.payload),
      })
      .pipe(Effect.option);
    if (Option.isNone(response)) {
      yield* Effect.logWarning("direct APNs push failed in transport", {
        deviceId: device.deviceId,
        pushType: request.pushType,
      });
      return { outcome: "error", removeToken: false } as const;
    }
    const { status, body } = response.value;
    if (status >= 200 && status < 300) return { outcome: "sent" } as const;
    const reason = reasonFromBody(body);
    yield* Effect.logWarning("direct APNs push rejected", {
      deviceId: device.deviceId,
      pushType: request.pushType,
      status,
      reason,
    });
    return {
      outcome: "rejected",
      status,
      reason,
      removeToken:
        status === 410 ||
        (status === 400 && reason !== undefined && PERMANENT_TOKEN_REASONS.has(reason)),
    } as const;
  });

  return DirectApnsClient.of({
    isConfigured: readCredentials.pipe(Effect.map(Option.isSome)),
    send,
  });
});

export const layer = Layer.effect(DirectApnsClient, make);
