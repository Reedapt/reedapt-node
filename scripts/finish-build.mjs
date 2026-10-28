// Finishes the build: dist/cjs gets its own package.json so Node reads its .js
// files as CommonJS, and declaration files point at .js, which every
// TypeScript version understands (tsc leaves the sources' .ts imports in them).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");

for (const root of ["dist/esm", "dist/cjs"]) {
  for (const entry of readdirSync(root, { recursive: true })) {
    const file = join(root, String(entry));
    if (!file.endsWith(".d.ts")) continue;
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
}
