// The guard's normalizer decodes base64 and hex with Node's Buffer. Browsers have no Buffer, so the
// landing-page demo gets this lenient stand-in: same inputs, same UTF-8 output, nothing else.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeBytes(input: string, encoding: "base64" | "hex"): Uint8Array {
  if (encoding === "hex") {
    const out = new Uint8Array(Math.floor(input.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // Like Node: skip characters outside the alphabet and stop at padding.
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of input) {
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) {
  const utf8 = new TextDecoder();
  g.Buffer = {
    from: (input: string, encoding: "base64" | "hex") => {
      const bytes = decodeBytes(input, encoding);
      return { toString: () => utf8.decode(bytes) };
    },
  };
}
