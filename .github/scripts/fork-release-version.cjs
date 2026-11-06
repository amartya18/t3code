const { readFileSync } = require("node:fs");

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-fork\.(\d+))?$/;
// X.Y.Z sorts after every X.Y.Z-fork.N.
const STABLE_BUILD = Number.MAX_SAFE_INTEGER;

function parseRelease(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return { major, minor, patch, build: match[4] === undefined ? STABLE_BUILD : Number(match[4]) };
}

function compareReleases(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.build - b.build;
}

function newestRelease(tags) {
  return tags.map(parseRelease).filter(Boolean).sort(compareReleases).at(-1);
}

function nextForkVersion(tags) {
  const newest = newestRelease(tags);
  if (newest === undefined) throw new Error("No release tag to base a fork release on.");
  const { major, minor, patch, build } = newest;
  return build === STABLE_BUILD
    ? `${major}.${minor}.${patch + 1}-fork.1`
    : `${major}.${minor}.${patch}-fork.${build + 1}`;
}

function resolveVersion(tags, requested) {
  if (requested === "") return nextForkVersion(tags);
  const release = parseRelease(`v${requested}`);
  if (release === null || release.build === STABLE_BUILD) return requested;
  const next = nextForkVersion(tags.filter((tag) => tag !== `v${requested}`));
  if (requested !== next) {
    throw new Error(`${requested} is not the next fork release, ${next}. Leave the version blank.`);
  }
  return requested;
}

module.exports = { resolveVersion };

if (require.main === module) {
  try {
    const tags = readFileSync(0, "utf8").split("\n").filter(Boolean);
    console.log(resolveVersion(tags, process.argv[2] ?? ""));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
