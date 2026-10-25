// Builds everything people download:
// - plugin/bin/a2a.mjs: the whole client (CLI, background client, MCP server) in one file, for the
//   Claude Code plug-in, also served by the website at /a2a.mjs
// - packages/sdk/dist: the @a2a/sdk package, packed into the website's /downloads
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "packages/web/public");
// CommonJS dependencies (ws, yaml) call require(); give ESM bundles a real one.
const requireShim = "import { createRequire as __a2aRequire } from 'node:module'; const require = __a2aRequire(import.meta.url);";
const common = { bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "none", logLevel: "warning" };

const cli = join(root, "plugin/bin/a2a.mjs");
await build({ ...common, entryPoints: [join(root, "packages/client/src/cli.ts")], outfile: cli, banner: { js: `#!/usr/bin/env node\n${requireShim}` } });
mkdirSync(web, { recursive: true });
copyFileSync(cli, join(web, "a2a.mjs"));
copyFileSync(cli, join(root, "packages/console/public/a2a.mjs"));

const sdk = join(root, "packages/sdk");
rmSync(join(sdk, "dist"), { recursive: true, force: true });
await build({ ...common, entryPoints: [join(sdk, "src/index.ts")], outfile: join(sdk, "dist/index.js"), banner: { js: requireShim } });
copyFileSync(join(sdk, "index.d.ts"), join(sdk, "dist/index.d.ts"));
copyFileSync(cli, join(sdk, "dist/cli.mjs"));
mkdirSync(join(web, "downloads"), { recursive: true });
const { version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
// A fixed command with our own path; npm is a .cmd shim on Windows, which needs a shell.
execSync(`npm pack --pack-destination "${join(web, "downloads")}"`, { cwd: sdk, stdio: "ignore" });
console.log(`built plugin/bin/a2a.mjs and downloads/a2a-sdk-${version}.tgz`);
