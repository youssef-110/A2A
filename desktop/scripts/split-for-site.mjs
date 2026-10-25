// Splits each built installer into parts under the 25 MiB Cloudflare asset limit and writes a
// manifest the Worker uses to stream them back as one download from /download/<os>.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PART = 24 * 1024 * 1024;
const out = join(import.meta.dirname, "..", "..", "packages", "web", "public", "downloads", "desktop");
const kinds = [
  ["windows", /-win-x64\.exe$/],
  ["mac", /-mac-.*\.dmg$/],
  ["linux", /-linux-.*\.AppImage$/],
];
mkdirSync(out, { recursive: true });
const built = readdirSync(join(import.meta.dirname, "..", "dist"));
for (const [os, pattern] of kinds) {
  const file = built.find((f) => pattern.test(f));
  if (!file) continue;
  for (const old of readdirSync(out).filter((f) => f.startsWith(`${os}-`) || f === `${os}.json`)) rmSync(join(out, old));
  const data = readFileSync(join(import.meta.dirname, "..", "dist", file));
  const parts = [];
  for (let i = 0; i * PART < data.length; i++) {
    const name = `${os}-${i}.bin`;
    writeFileSync(join(out, name), data.subarray(i * PART, (i + 1) * PART));
    parts.push(name);
  }
  const manifest = { file: file.replace(/-win-x64(?=\.exe$)/, ""), size: data.length, sha256: createHash("sha256").update(data).digest("hex"), parts };
  writeFileSync(join(out, `${os}.json`), JSON.stringify(manifest, null, 2));
  console.log(`${os}: ${file} -> ${parts.length} parts (${(data.length / 1048576).toFixed(1)} MiB)`);
}
