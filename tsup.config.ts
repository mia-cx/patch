import { defineConfig } from "tsup";

// Node's sqlite builtin requires its node: prefix at runtime.
export default defineConfig({ removeNodeProtocol: false });
