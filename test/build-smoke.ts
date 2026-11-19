import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Load the actual bundle without credentials or a network connection.
const result = spawnSync(process.execPath, [resolve("dist/index.js")], {
  encoding: "utf8",
  timeout: 10_000,
  env: {
    ...process.env,
    DISCORD_TOKEN: "",
    DISCORD_CLIENT_ID: "",
    DOTENV_CONFIG_PATH: "/dev/null",
  },
});
if (result.error) throw result.error;
assert.match(
  result.stderr,
  /Missing required env var DISCORD_TOKEN/,
  `The built app must load its dependencies before rejecting missing credentials:\n${result.stderr}`,
);
assert.equal(result.status, 1);
console.log(
  "Built app loads its dependencies and reaches configuration validation",
);
