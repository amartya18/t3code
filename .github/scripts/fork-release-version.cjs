const { readFileSync } = require("node:fs");

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function nextForkVersion(tags) {
  const [major, minor, patch] =
    tags
      .flatMap((tag) => {
        const match = STABLE_TAG.exec(tag);
        return match === null ? [] : [match.slice(1).map(Number)];
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
      .at(-1) ?? [];
  if (major === undefined) throw new Error("No stable vX.Y.Z tag to base a fork release on.");

  const base = `${major}.${minor}.${patch + 1}`;
  const prefix = `v${base}-fork.`;
  const builds = tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number(tag.slice(prefix.length)));
  return `${base}-fork.${Math.max(0, ...builds) + 1}`;
}

module.exports = { nextForkVersion };

if (require.main === module) {
  console.log(nextForkVersion(readFileSync(0, "utf8").split("\n").filter(Boolean)));
}
