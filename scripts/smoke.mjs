// Loads the built package both ways and runs a request against a fake fetch.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const cjs = require("../dist/cjs/index.js");
const esm = await import("../dist/esm/index.js");

for (const lib of [cjs, esm]) {
  const fetch = async () => new Response(JSON.stringify({ target_languages: ["fr"] }), { status: 200 });
  const reedapt = new lib.Reedapt({ apiKey: "rk_test_smoke", fetch });
  assert.deepEqual(await reedapt.languages.list(), { target_languages: ["fr"] });
  assert.equal(typeof lib.constructWebhookEvent, "function");
}
console.log(`ok on Node ${process.version}`);
