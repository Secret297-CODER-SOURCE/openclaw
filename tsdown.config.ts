import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

// tsdown defaults to clean: true, which would wipe the entire dist/ directory
// including dist/control-ui/ (built separately by pnpm ui:build). Disable
// cleaning for all entries that share the default outDir so the UI assets are
// never accidentally deleted. Named outputs (index.js, entry.js, …) are
// always overwritten by filename; stale hashed chunks are harmless.
const noClean = { clean: false } as const;

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    entry: "src/cli/daemon-cli.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/account-id.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
]);
