import type { Normalized } from "./normalize.ts";

export interface Finding {
  category: string;
  detail: string;
  /** Span in the normalized text, when the finding can be located (and therefore redacted). */
  start?: number;
  end?: number;
  source: "text" | "decoded" | "attachment";
}

interface Pattern {
  category: string;
  detail: string;
  re: RegExp;
  /** Capture group to report as the span (defaults to the whole match). */
  group?: number;
}

const SECRET_PATTERNS: Pattern[] = [
  { category: "secret_detected", detail: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: "secret_detected", detail: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { category: "secret_detected", detail: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { category: "secret_detected", detail: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { category: "secret_detected", detail: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { category: "secret_detected", detail: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { category: "secret_detected", detail: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|$)/g },
  { category: "secret_detected", detail: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    category: "secret_detected",
    detail: "Credential assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
    group: 1,
  },
];

const INJECTION_PATTERNS: Pattern[] = [
  { category: "instruction_override", detail: "Asks to ignore earlier instructions", re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|all|your|system|original)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directives|guidelines|guardrails)\b/gi },
  { category: "instruction_override", detail: "Claims a new set of instructions", re: /\b(?:new|updated|real|revised|override)\s+(?:system\s+)?(?:instructions?|prompt|directives?|orders)\s*[:\-]/gi },
  { category: "instruction_override", detail: "Tries to change the agent's role", re: /\byou are (?:now|no longer)\b[^.\n]{0,40}\b(?:DAN|developer mode|maintenance mode|unrestricted|jailbroken|without (?:any )?restrictions|an? (?:different|new) (?:agent|assistant|AI)|(?:the|an?|my)\s+(?:[\w-]+\s+){0,3}(?:administrator|admin|superuser|root user|owner))/gi },
  { category: "instruction_override", detail: "Fake role or system tags", re: /<\/?\s*(?:system|assistant|developer|im_start|im_end|instructions?)\s*>|<\|im_(?:start|end)\|>|\[\/?(?:INST|SYS)\]/gi },
  { category: "instruction_override", detail: "Tries to close the message wrapper", re: /<\/?\s*a2a-message\b|<<<\s*END\s+MESSAGE/gi },
  { category: "instruction_override", detail: "Asks to reveal hidden instructions", re: /\b(?:reveal|print|show|output|repeat|dump)\b[^.\n]{0,20}\b(?:your|the)\s+(?:system prompt|hidden instructions|initial instructions|instructions above)/gi },
  { category: "instruction_override", detail: "Asks to hide actions from the operator", re: /\b(?:do not|don't|never)\s+(?:tell|inform|mention (?:this )?to|alert|notify)\s+(?:the |your )?(?:user|operator|human|admin|owner)/gi },
];

const ACTION_PATTERNS: Pattern[] = [
  {
    category: "credential_request",
    detail: "Requests credentials or secrets",
    // Negated phrasing ("I won't share API keys") is a refusal, not a request.
    re: /(?<!\b(?:won't|will not|can't|cannot|can not|don't|do not|never|not|shouldn't|should not)\s+(?:\w+\s+)?)\b(?:send|give|share|paste|provide|tell|show|print|output|dump|reveal|forward|read out|(?:email|post|text|dm|slack)\s+(?:me|us|them|it|this|that))\b[^.\n?]{0,40}(?:\b(?:api[ _-]?keys?|passwords?|credentials?|secrets?|tokens?|private keys?|ssh keys?|id_rsa|env(?:ironment)? (?:vars|variables)|access keys?|session cookies?)|\.env\b)/gi,
  },
  { category: "credential_request", detail: "Reads credential files", re: /(?:~|\$HOME)?\/?\.(?:ssh\/id_[a-z0-9]+|aws\/credentials|netrc|npmrc|docker\/config\.json)\b|\/etc\/shadow\b/gi },
  {
    category: "dangerous_action",
    detail: "Destructive or remote-code command",
    re: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\*|\$HOME)|\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|:\(\)\s*\{\s*:\|:&\s*\};:|\bmkfs(?:\.\w+)?\s|\bchmod\s+-R\s+777\s+\/|\bgit\s+push\s+(?:--force|-f)\b[^\n]*\b(?:main|master|prod)/gi,
  },
  {
    category: "dangerous_action",
    detail: "Asks to disable safety controls",
    re: /\b(?:disable|turn off|bypass|skip|remove)\b[^.\n]{0,25}\b(?:2fa|mfa|authentication|the guard|guardrails|safety checks|audit log(?:ging)?|monitoring|branch protection|code review)\b/gi,
  },
  {
    category: "data_exfiltration",
    detail: "Sends data to an outside destination",
    re: /(?<!\b(?:won't|will not|can't|cannot|can not|don't|do not|never|not|shouldn't|should not)\s+(?:\w+\s+)?)\b(?:send|post|upload|forward|exfiltrate|copy|sync|transmit|email)\b[^\n]{0,80}?\b(?:to|into)\s+(?:https?:\/\/|ftp:\/\/|[\w.+-]+@[\w-]+\.[a-z]{2,}|(?:my|this|an?|the) (?:external|personal|private) )/gi,
  },
  {
    category: "social_engineering",
    detail: "Pressure or false authority",
    re: /\b(?:urgent(?:ly)?|immediately|right now|asap)\b[^.\n]{0,60}\b(?:without|skip|no need for|don't wait for)\b[^.\n]{0,30}\b(?:approval|review|checking|verification|confirm)|\b(?:i am|this is)\s+(?:the |your )?(?:ceo|cto|admin(?:istrator)?|security team|anthropic|openai|system administrator)\b[^.\n]{0,40}\b(?:authori[sz]e|order|instruct|approve)/gi,
  },
];

const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function runPatterns(text: string, patterns: Pattern[], source: Finding["source"], span?: [number, number]): Finding[] {
  const out: Finding[] = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      let start = m.index!;
      let end = start + m[0].length;
      if (p.group && m[p.group]) {
        start += m[0].indexOf(m[p.group]!);
        end = start + m[p.group]!.length;
      }
      out.push({ category: p.category, detail: p.detail, source, start: span ? span[0] : start, end: span ? span[1] : end });
    }
  }
  return out;
}

function scanPlain(text: string, source: Finding["source"], span?: [number, number]): Finding[] {
  const findings = [
    ...runPatterns(text, SECRET_PATTERNS, source, span),
    ...runPatterns(text, INJECTION_PATTERNS, source, span),
    ...runPatterns(text, ACTION_PATTERNS, source, span),
  ];
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits) && !/^(\d)\1+$/.test(digits)) {
      findings.push({ category: "payment_card", detail: "Payment card number", source, start: span ? span[0] : m.index!, end: span ? span[1] : m.index! + m[0].length });
    }
  }
  for (const m of text.matchAll(SSN_RE)) {
    findings.push({ category: "pii", detail: "US Social Security number", source, start: span ? span[0] : m.index!, end: span ? span[1] : m.index! + m[0].length });
  }
  return findings;
}

const TEXT_MIME_RE = /^(?:text\/|application\/(?:json|xml|yaml|x-yaml|csv|javascript|x-sh))/;
const TEXT_NAME_RE = /\.(?:md|markdown|txt|json|ya?ml|csv|xml|html?|js|ts|py|sh|ps1)$/i;
const RISKY_MIME_RE = /^application\/(?:x-msdownload|x-executable|x-mach-binary|x-sh|x-msdos-program|vnd\.microsoft\.portable-executable|java-archive)/;

export interface AttachmentInput {
  name: string;
  mime: string;
  data: string;
}

/** Stage 2b: deterministic content scanners over the normalized text, decoded payloads and text attachments. */
export function scan(n: Normalized, attachments: AttachmentInput[] = []): Finding[] {
  const findings = scanPlain(n.scanText, "text");

  for (const seg of n.decoded) {
    findings.push({ category: "encoded_payload", detail: `${seg.encoding} payload decoded`, source: "decoded", start: seg.start, end: seg.end });
    findings.push(...scanPlain(seg.text, "decoded", [seg.start, seg.end]));
  }
  if (n.removedInvisible > 0) {
    findings.push({ category: "obfuscation", detail: `${n.removedInvisible} invisible or bidi control characters removed`, source: "text" });
  }
  if (n.homoglyphWords.length > 0) {
    findings.push({ category: "obfuscation", detail: `Mixed-script look-alike words: ${n.homoglyphWords.slice(0, 5).join(", ")}`, source: "text" });
  }
  for (const a of attachments) {
    if (RISKY_MIME_RE.test(a.mime) || /\.(?:exe|dll|scr|bat|cmd|ps1|sh|app|dmg|pkg|jar)$/i.test(a.name)) {
      findings.push({ category: "attachment_type", detail: `Executable attachment: ${a.name}`, source: "attachment" });
    }
    // Judge by name as well as declared type, so "notes.md" sent as octet-stream is still read.
    if (TEXT_MIME_RE.test(a.mime) || TEXT_NAME_RE.test(a.name)) {
      const content = Buffer.from(a.data, "base64").toString("utf8").normalize("NFKC");
      for (const f of scanPlain(content, "attachment")) findings.push({ ...f, detail: `${f.detail} (in ${a.name})`, start: undefined, end: undefined });
    }
  }
  return findings;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
export const extractUrls = (text: string): string[] => [...text.matchAll(URL_RE)].map((m) => m[0]);
