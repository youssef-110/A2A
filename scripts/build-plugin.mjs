// Bundles the a2a client (CLI, background client, MCP server) into one file that runs on any
// machine with Node 22.13+: plugin/bin/a2a.mjs for the Claude Code plug-in, plus a copy the relay
// serves at /a2a.mjs for people who don't use the plug-in.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "plugin/bin/a2a.mjs");

await build({
  entryPoints: [join(root, "packages/client/src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // CommonJS dependencies (ws, yaml) call require(); give the ESM bundle a real one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __a2aRequire } from 'node:module'; const require = __a2aRequire(import.meta.url);" },
  logLevel: "info",
});

const served = join(root, "packages/console/public/a2a.mjs");
mkdirSync(dirname(served), { recursive: true });
copyFileSync(outfile, served);
console.log(`copied to ${served}`);
