/** Generate a private, byte-bound OFFLINE caller contract. This never imports or runs qualify.ts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditFullCaller } from "./audit.js";

const outputArg = process.argv[2];
assert(
  outputArg && process.argv.length === 3,
  "Pass a new private preparation directory",
);
const output = resolve(outputArg);
mkdirSync(output, { mode: 0o700 });
const audit = await auditFullCaller();
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const write = (name: string, value: string) => {
  const path = resolve(output, name);
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
  return path;
};
const persona = write("persona.txt", audit.persona);
write("persona-shared.txt", audit.sharedPersona);
write("persona-continuation.txt", audit.continuationPersona);
write("persona-shared-continuation.txt", audit.sharedContinuationPersona);
write("persona-final.txt", audit.finalPersona);
write("persona-shared-final.txt", audit.sharedFinalPersona);
write("audit.json", JSON.stringify(audit.report, null, 2));
const files: Record<string, string> = {};
function include(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) include(path);
    else if (
      !entry.name.endsWith(".test.ts") &&
      /\.(ts|js|json|md)$/.test(entry.name) &&
      !entry.name.endsWith(".map")
    )
      files[path] = digest(path);
  }
}
// Pin owned sources, prompt files and actual imported Protocord JS. External packages are pinned by lockfile.
include(resolve("src"));
include(resolve("prompts"));
include(resolve("test/full-caller"));
include(resolve("test/fixtures"));
include(resolve("spec/fixtures"));
include(resolve("vendor/protocord/packages/protocord/dist"));
for (const name of [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "spec/all-stream-evidence.md",
  "spec/fixtures/all-stream-evidence.json",
  persona,
  resolve(output, "persona-shared.txt"),
  resolve(output, "persona-continuation.txt"),
  resolve(output, "persona-shared-continuation.txt"),
  resolve(output, "persona-final.txt"),
  resolve(output, "persona-shared-final.txt"),
  resolve(output, "audit.json"),
]) {
  const path = resolve(name);
  files[path] = digest(path);
}
assert(
  Object.keys(files).length <= 256,
  "Caller closure exceeds controller budget",
);
const contract = {
  schema: "full-caller-contract-v1",
  entrypoint: resolve("test/full-caller/qualify.ts"),
  files,
  persona: { path: persona, sha256: digest(persona) },
  required_limits: audit.required_limits,
};
const path = write("contract.json", JSON.stringify(contract, null, 2));
console.log(
  JSON.stringify({
    path,
    sha256: digest(path),
    files: Object.keys(files).length,
    required_limits: contract.required_limits,
    qualification_script_executed: false,
  }),
);
