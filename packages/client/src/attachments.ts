import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

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

/** A context capsule's Brief (between its BRIEF markers), or null when the text isn't a sealed capsule. */
export function capsuleBrief(text: string): string | null {
  if (!text.startsWith("<!-- capsule ")) return null;
  const m = /<!-- BRIEF:START -->\s*([\s\S]*?)\s*<!-- BRIEF:END -->/.exec(text);
  return m?.[1]?.trim() || null;
}
