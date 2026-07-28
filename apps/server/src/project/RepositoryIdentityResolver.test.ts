import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);
const successfulProcessResult = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});
const failedProcessResult: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(128),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
};
const timedOutProcessResult: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: null,
  timedOut: true,
  stdoutTruncated: false,
  stderrTruncated: false,
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

const makeMockRepositoryIdentityResolverTestLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({ cacheCapacity: 16 }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    ),
  );

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("reuses the cached Git root for repeated workspace lookups", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? "/repo\n"
              : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const first = yield* resolver.resolve("/repo/packages/web");
      const second = yield* resolver.resolve("/repo/packages/web");

      expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(second).toEqual(first);
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);
    }).pipe(Effect.provide(resolverLayer));
  });

  it.effect("retries Git root discovery after a failed lookup", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootAttempts = 0;
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const rootLookup = input.args.includes("rev-parse");
          const failed = rootLookup && rootAttempts++ === 0;
          return {
            stdout: rootLookup
              ? failed
                ? ""
                : "/repo\n"
              : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
            stderr: failed ? "temporary Git failure" : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();

      const recovered = yield* resolver.resolve("/repo/packages/web");
      expect(recovered?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);
    }).pipe(Effect.provide(resolverLayer));
  });

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : yield* fileSystem.realPath(identity.rootPath);
      const resolvedCwd = yield* fileSystem.realPath(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : yield* fileSystem.realPath(identity.rootPath);
      const resolvedRepoRoot = yield* fileSystem.realPath(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("prefers upstream over origin when both remotes are configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-upstream-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.locator.remoteName).toBe("upstream");
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("t3tools/platform/t3code");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});

it.effect("passes an explicit five-second timeout to both Git metadata commands", () => {
  const inputs: ProcessRunner.ProcessRunInput[] = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.sync(() => {
      inputs.push(input);
      return input.args.includes("rev-parse")
        ? successfulProcessResult("/workspace\n")
        : successfulProcessResult("origin\thttps://github.com/T3Tools/t3code.git (fetch)\n");
    });

  return Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    const identity = yield* resolver.resolve("/workspace");

    expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(Duration.toMillis(Duration.fromInputUnsafe(input.timeout ?? Duration.zero))).toBe(
        5_000,
      );
      expect(input.timeoutBehavior).toBe("timedOutResult");
    }
  }).pipe(Effect.provide(makeMockRepositoryIdentityResolverTestLayer(run)));
});

it.effect("returns null when a Git metadata command times out", () => {
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.succeed(
      input.args.includes("rev-parse")
        ? successfulProcessResult("/workspace\n")
        : timedOutProcessResult,
    );

  return Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    expect(yield* resolver.resolve("/workspace")).toBeNull();
  }).pipe(Effect.provide(makeMockRepositoryIdentityResolverTestLayer(run)));
});

it.effect("caches the complete positive resolution by workspace directory", () => {
  const inputs: ProcessRunner.ProcessRunInput[] = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.sync(() => {
      inputs.push(input);
      return input.args.includes("rev-parse")
        ? successfulProcessResult("/repository\n")
        : successfulProcessResult("origin\thttps://github.com/T3Tools/t3code.git (fetch)\n");
    });

  return Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    yield* resolver.resolve("/repository/packages/web");
    yield* resolver.resolve("/repository/packages/web");

    expect(inputs.filter((input) => input.args.includes("rev-parse"))).toHaveLength(1);
    expect(inputs.filter((input) => input.args.includes("remote"))).toHaveLength(1);
  }).pipe(Effect.provide(makeMockRepositoryIdentityResolverTestLayer(run)));
});

it.effect("caches negative results for non-Git workspace directories", () => {
  const inputs: ProcessRunner.ProcessRunInput[] = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.sync(() => {
      inputs.push(input);
      return failedProcessResult;
    });

  return Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    expect(yield* resolver.resolve("/not-a-repository")).toBeNull();
    expect(yield* resolver.resolve("/not-a-repository")).toBeNull();

    expect(inputs.filter((input) => input.args.includes("rev-parse"))).toHaveLength(1);
    expect(inputs.filter((input) => input.args.includes("remote"))).toHaveLength(1);
  }).pipe(Effect.provide(makeMockRepositoryIdentityResolverTestLayer(run)));
});

it.effect("keeps cache entries independent for different workspace directories", () => {
  const inputs: ProcessRunner.ProcessRunInput[] = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.sync(() => {
      inputs.push(input);
      const cwd = input.args[1] ?? "";
      return input.args.includes("rev-parse")
        ? successfulProcessResult(`${cwd}\n`)
        : successfulProcessResult(`origin\thttps://github.com/acme${cwd}.git (fetch)\n`);
    });

  return Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    yield* resolver.resolve("/workspace-one");
    yield* resolver.resolve("/workspace-two");
    yield* resolver.resolve("/workspace-one");

    expect(
      inputs.filter((input) => input.args.includes("rev-parse")).map((input) => input.args[1]),
    ).toEqual(["/workspace-one", "/workspace-two"]);
  }).pipe(Effect.provide(makeMockRepositoryIdentityResolverTestLayer(run)));
});

it.effect("retries after an interrupted cache load instead of retaining a poisoned entry", () =>
  Effect.gen(function* () {
    const firstLookupStarted = yield* Deferred.make<void>();
    let revParseCalls = 0;
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
      if (input.args.includes("rev-parse")) {
        revParseCalls += 1;
        if (revParseCalls === 1) {
          return Deferred.succeed(firstLookupStarted, undefined).pipe(Effect.andThen(Effect.never));
        }
        return Effect.succeed(successfulProcessResult("/workspace\n"));
      }
      return Effect.succeed(
        successfulProcessResult("origin\thttps://github.com/T3Tools/t3code.git (fetch)\n"),
      );
    };

    const resolver = yield* RepositoryIdentityResolver.make({ cacheCapacity: 16 }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    );
    const firstResolve = yield* resolver
      .resolve("/workspace")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(firstLookupStarted);
    yield* Fiber.interrupt(firstResolve);

    const identity = yield* resolver.resolve("/workspace");
    expect(revParseCalls).toBe(2);
    expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
  }),
);
