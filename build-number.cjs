// The iOS buildNumber and Android versionCode of a version. Each store takes a
// build number only once and every release raises the version, so the number
// comes from the version: 1.2.3 builds as 1002003. An app's app.config.ts and
// the release commands both use it. Plain CommonJS with no dependencies, since
// Expo loads app.config.ts with Node's require: importing it runs nothing else.

// Google Play takes version codes up to 2100000000.
const MAX = 2_100_000_000;

/** @param {string} version MAJOR.MINOR.PATCH */
function buildNumber(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`the version ${version} isn't MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 999 || patch > 999)
    throw new Error(
      `the version ${version} can't be a build number: minor and patch go up to 999`,
    );
  const number = major * 1_000_000 + minor * 1_000 + patch;
  if (number < 1 || number > MAX)
    throw new Error(
      `the version ${version} can't be a build number: it must be from 0.0.1 to 2100.0.0`,
    );
  return number;
}

module.exports = { buildNumber };
