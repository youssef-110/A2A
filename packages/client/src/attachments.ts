import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

/** Raw bytes across all files. Base64 grows them by a third, and the relay's default limit is 256 KiB per message. */
export const MAX_ATTACHMENT_BYTES = 180 * 1024;

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

export function readAttachments(paths: string[]): { name: string; mime: string; data: string }[] {
  let total = 0;
  return paths.map((p) => {
    const file = resolve(p);
    const size = statSync(file).size;
    total += size;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments are ${Math.round(total / 1024)} KiB; the limit is ${MAX_ATTACHMENT_BYTES / 1024} KiB. For a capsule, export it again with a smaller --budget.`);
    }
    return { name: basename(file), mime: MIME[extname(file).toLowerCase()] ?? "application/octet-stream", data: readFileSync(file).toString("base64") };
  });
}

/**
 * What an agent (rather than a person at the CLI) may attach: sealed context capsules only, never
 * anything inside the a2a home. A message can talk an agent into attaching a file, so arbitrary
 * paths like ~/.ssh/id_ed25519 must not be sendable this way.
 */
export function readCapsuleAttachments(paths: string[], home: string): { name: string; mime: string; data: string }[] {
  const homeReal = existsSync(home) ? realpathSync(home) : resolve(home);
  for (const p of paths) {
    const real = realpathSync(resolve(p));
    if (!/\.capsule\.md$/i.test(real)) throw new Error(`Only context capsules (*.capsule.md) can be attached from here; ${basename(real)} isn't one. A person can attach other files with \`a2a send --attach\`.`);
    const rel = relative(homeReal, real);
    if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("Files inside the a2a folder can't be attached.");
    const head = readFileSync(real, "utf8").slice(0, 32);
    if (!head.startsWith("<!-- capsule ")) throw new Error(`${basename(real)} isn't a sealed capsule. Export and seal it with the capsule skill first.`);
  }
  return readAttachments(paths.map((p) => realpathSync(resolve(p))));
}

/** A context capsule's Brief (between its BRIEF markers), or null when the text isn't a sealed capsule. */
export function capsuleBrief(text: string): string | null {
  if (!text.startsWith("<!-- capsule ")) return null;
  const m = /<!-- BRIEF:START -->\s*([\s\S]*?)\s*<!-- BRIEF:END -->/.exec(text);
  return m?.[1]?.trim() || null;
}
