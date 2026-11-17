// Writes the fixture app (test/fixture.ts) into a folder, for the consumer
// check in CI: bun test/make-fixture.ts <folder> [version]
import { makeApp } from "./fixture.ts";

const [folder, version] = process.argv.slice(2);
if (!folder) {
  console.error("usage: bun test/make-fixture.ts <folder> [version]");
  process.exit(2);
}
makeApp(folder, version);
console.log(`Wrote the fixture app to ${folder}.`);
