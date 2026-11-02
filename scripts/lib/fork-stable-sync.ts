export type GithubRelease = {
  readonly tag_name: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
};

export type PublishPlan =
  | {
      readonly _tag: "Skip";
      readonly reason: "no-stable" | "already-published";
      readonly tag?: string;
    }
  | { readonly _tag: "Build"; readonly tag: string; readonly version: string };

const STABLE_TAG = /^v([0-9]+\.[0-9]+\.[0-9]+)$/;

export function isStableReleaseTag(tag: string): boolean {
  return STABLE_TAG.test(tag.trim());
}

export function versionFromStableTag(tag: string): string | undefined {
  return STABLE_TAG.exec(tag.trim())?.[1];
}

export function selectNewestStableTag(releases: readonly GithubRelease[]): string | undefined {
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    if (isStableReleaseTag(release.tag_name)) return release.tag_name;
  }
  return undefined;
}

export function planPublish(input: {
  readonly upstreamReleases: readonly GithubRelease[];
  readonly forkTags: readonly string[];
  readonly requestedTag?: string;
}): PublishPlan {
  const requested = input.requestedTag?.trim();
  const tag = requested
    ? isStableReleaseTag(requested)
      ? requested.startsWith("v")
        ? requested
        : `v${requested}`
      : undefined
    : selectNewestStableTag(input.upstreamReleases);

  if (requested && !tag) {
    return { _tag: "Skip", reason: "no-stable", tag: requested };
  }
  if (!tag) return { _tag: "Skip", reason: "no-stable" };

  const normalized = tag.startsWith("v") ? tag : `v${tag}`;
  if (!isStableReleaseTag(normalized)) {
    return { _tag: "Skip", reason: "no-stable", tag: normalized };
  }

  if (input.forkTags.includes(normalized)) {
    return { _tag: "Skip", reason: "already-published", tag: normalized };
  }

  const version = versionFromStableTag(normalized);
  if (!version) return { _tag: "Skip", reason: "no-stable", tag: normalized };

  return { _tag: "Build", tag: normalized, version };
}

export function formatGithubOutput(plan: PublishPlan): string {
  if (plan._tag === "Skip") {
    return [`decision=skip`, `reason=${plan.reason}`, plan.tag ? `tag=${plan.tag}` : undefined]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  return [`decision=build`, `tag=${plan.tag}`, `version=${plan.version}`].join("\n");
}

export function publishedTagsFromReleases(releases: readonly GithubRelease[]): string[] {
  return releases.filter((release) => !release.draft).map((release) => release.tag_name);
}

function asRelease(value: unknown): GithubRelease {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a GitHub release object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || record.tag_name.length === 0) {
    throw new Error("release is missing tag_name");
  }
  return {
    tag_name: record.tag_name,
    prerelease: Boolean(record.prerelease),
    draft: Boolean(record.draft),
  };
}

/** GitHub's array JSON, or one release object per line from `gh api --jq`. */
export function parseGithubReleasesJson(raw: string): GithubRelease[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array of GitHub releases");
    }
    return parsed.map(asRelease);
  }
  return trimmed
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => asRelease(JSON.parse(line)));
}

export function patchCommitRange(mergeBase: string): string {
  return `${mergeBase}..HEAD`;
}
