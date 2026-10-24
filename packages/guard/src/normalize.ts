/**
 * Stage 2a: normalization. The recipient receives the normalized text, so whatever the
 * scanners and judge see is exactly what gets delivered.
 */

export interface DecodedSegment {
  encoding: "base64" | "hex" | "url";
  /** Span of the encoded blob in the normalized text. */
  start: number;
  end: number;
  text: string;
}

export interface Normalized {
  /** NFKC, invisible and bidi control characters removed. Delivered to the recipient. */
  text: string;
  /** Same length as `text`, with confusable letters folded to ASCII. Used for pattern matching only. */
  scanText: string;
  removedInvisible: number;
  homoglyphWords: string[];
  decoded: DecodedSegment[];
}

// Zero-width, soft hyphen, word joiner, BOM, bidi embeddings/overrides/isolates, marks, tag characters.
const INVISIBLE_RE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

// Cyrillic and Greek letters that render like Latin ones. One code unit each, so spans stay aligned.
const CONFUSABLES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", ӏ: "l",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", І: "I", Ј: "J", Ѕ: "S",
  α: "a", ο: "o", ρ: "p", τ: "t", υ: "u", ν: "v", ι: "i", κ: "k", χ: "x",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};

const LATIN_RE = /[A-Za-z]/;
const MIXED_SCRIPT_RE = /[Ͱ-ϿЀ-ӿԀ-ԯ]/;

function isMostlyPrintable(s: string): boolean {
  if (s.length < 8) return false;
  let ok = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c < 0x7f) || c === 0x0a || c === 0x0d || c === 0x09 || (c >= 0xa0 && c !== 0xfffd)) ok++;
  }
  return ok / [...s].length >= 0.9 && /[a-zA-Z]{3,}/.test(s) && /\s/.test(s);
}

function decodeBlobs(text: string, offset: number, depth: number, out: DecodedSegment[]): void {
  if (depth > 2 || out.length > 20) return;
  const found: DecodedSegment[] = [];

  for (const m of text.matchAll(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{20,}={0,2}(?![A-Za-z0-9+/=_-])/g)) {
    const blob = m[0];
    if (/^[0-9a-fA-F]+$/.test(blob)) continue; // left to the hex pass
    const decoded = Buffer.from(blob.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (isMostlyPrintable(decoded)) found.push({ encoding: "base64", start: offset + m.index!, end: offset + m.index! + blob.length, text: decoded });
  }
  for (const m of text.matchAll(/(?<![0-9a-fA-F])(?:[0-9a-fA-F]{2}){12,}(?![0-9a-fA-F])/g)) {
    const decoded = Buffer.from(m[0], "hex").toString("utf8");
    if (isMostlyPrintable(decoded)) found.push({ encoding: "hex", start: offset + m.index!, end: offset + m.index! + m[0].length, text: decoded });
  }
  for (const m of text.matchAll(/\S*(?:%[0-9A-Fa-f]{2}){4,}\S*/g)) {
    try {
      const decoded = decodeURIComponent(m[0]);
      if (decoded !== m[0] && isMostlyPrintable(decoded)) found.push({ encoding: "url", start: offset + m.index!, end: offset + m.index! + m[0].length, text: decoded });
    } catch {
      /* not valid percent-encoding */
    }
  }

  for (const seg of found) {
    out.push(seg);
    // Nested encodings keep the outer span so a redaction removes the whole blob.
    const nested: DecodedSegment[] = [];
    decodeBlobs(seg.text, 0, depth + 1, nested);
    for (const n of nested) out.push({ ...n, start: seg.start, end: seg.end });
  }
}

export function normalize(input: string): Normalized {
  let removedInvisible = 0;
  const text = input.normalize("NFKC").replace(INVISIBLE_RE, () => {
    removedInvisible++;
    return "";
  });

  let scanText = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    scanText += CONFUSABLES[ch] ?? ch;
  }

  const homoglyphWords: string[] = [];
  for (const m of text.matchAll(/[\p{L}]+/gu)) {
    const w = m[0];
    if (LATIN_RE.test(w) && MIXED_SCRIPT_RE.test(w)) homoglyphWords.push(w);
  }

  const decoded: DecodedSegment[] = [];
  decodeBlobs(text, 0, 0, decoded);

  return { text, scanText, removedInvisible, homoglyphWords, decoded };
}
