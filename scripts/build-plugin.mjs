// Builds everything people download:
// - plugin/bin/a2a.mjs: the whole client (CLI, background client, MCP server) in one file, for the
//   Claude Code plug-in, also served by the website at /a2a.mjs
// - packages/sdk/dist: the @a2a/sdk package, packed into the website's /downloads
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// npx runs the bin without node flags: hide Node's "SQLite is experimental" notice, then load the CLI.
writeFileSync(
  join(sdk, "dist/bin.mjs"),
  [
    "#!/usr/bin/env node",
    "const emit = process.emitWarning;",
    "process.emitWarning = (w, ...rest) => (/SQLite/.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));",
    'await import("./cli.mjs");',
    "",
  ].join("\n"),
);
mkdirSync(join(web, "downloads"), { recursive: true });
const { version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
// A fixed command with our own path; npm is a .cmd shim on Windows, which needs a shell.
execSync(`npm pack --pack-destination "${join(web, "downloads")}"`, { cwd: sdk, stdio: "ignore" });
// Pages and invite prompts read this to point at the current version (npx caches by URL, so the name must change).
writeFileSync(join(web, "downloads", "latest.json"), `${JSON.stringify({ version, file: `a2a-sdk-${version}.tgz` })}\n`);
console.log(`built plugin/bin/a2a.mjs and downloads/a2a-sdk-${version}.tgz`);
