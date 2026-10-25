import { parse as parseYaml } from "yaml";

export type JudgeMode = "auto" | "anthropic" | "claude-cli" | "heuristic" | "off";

export interface ScopeDef {
  description: string;
  /** Optional hints for the offline heuristic judge. The LLM judges read the description instead. */
  keywords?: string[];
}

export interface LinkRule {
  from: string;
  to: string;
  scopes: string[];
  rate?: { count: number; windowMs: number; text: string };
}

export interface Limits {
  max_hops_per_thread: number;
  max_messages_per_thread: number;
  max_body_bytes: number;
  message_ttl_ms: number;
  /** Senders with more blocked messages than this in the last hour get throttled. */
  max_blocks_per_hour: number;
}

export interface Rules {
  block: string[];
  hold: string[];
  redact: string[];
}

export interface GuardSettings {
  judge: JudgeMode;
  min_confidence: number;
  escalate: boolean;
  timeout_ms: number;
  on_error: "hold" | "block";
  /**
   * The strictest decision the content stages (scanners and judges) may reach. "hold" turns every
   * would-be block into a hold, so a person decides. Envelope rules (links, limits, signatures)
   * still block.
   */
  max_decision: "hold" | "block";
}

/**
 * How agents join without the admin token:
 * - approval: they register as pending until an admin approves them (the default).
 * - invite: an invite link from the console activates them; anything else waits for approval.
 * - open: anyone who proves their key is active straight away. For trusted networks only.
 */
export type Registration = "approval" | "invite" | "open";

/**
 * Who may start a conversation with whom:
 * - links: the `links` rules decide (the default).
 * - sessions: the owner's agents reach everyone in the owner's sessions; guests reach only the
 *   people who share a session with them. Each session is a private line set up from the dashboard.
 */
export type Isolation = "links" | "sessions";

export interface Policy {
  org: string;
  registration: Registration;
  isolation: Isolation;
  scopes: Record<string, ScopeDef>;
  links: LinkRule[];
  limits: Limits;
  rules: Rules;
  guard: GuardSettings;
}

export const DEFAULT_LIMITS: Limits = {
  max_hops_per_thread: 12,
  max_messages_per_thread: 40,
  max_body_bytes: 65536,
  message_ttl_ms: 24 * 3600_000,
  max_blocks_per_hour: 10,
};

export const DEFAULT_RULES: Rules = {
  block: ["instruction_override", "credential_request", "payment_card", "dangerous_action", "data_exfiltration"],
  hold: ["out_of_scope", "pii", "obfuscation", "social_engineering", "attachment_type"],
  redact: ["secret_detected"],
};

export const DEFAULT_GUARD: GuardSettings = {
  judge: "auto",
  min_confidence: 0.7,
  escalate: true,
  timeout_ms: 30_000,
  on_error: "hold",
  max_decision: "block",
};

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 };

export function parseDuration(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value * 1000;
  const m = typeof value === "string" ? DURATION_RE.exec(value.trim()) : null;
  if (!m) {
    errors.push(`${field}: expected a duration like 30m, 24h or 7d`);
    return undefined;
  }
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

function parseRate(value: unknown, field: string, errors: string[]): LinkRule["rate"] {
  if (value === undefined) return undefined;
  const m = typeof value === "string" ? /^(\d+)\s*\/\s*(second|minute|hour|day)$/.exec(value.trim()) : null;
  if (!m) {
    errors.push(`${field}: expected a rate like 60/hour`);
    return undefined;
  }
  const windowMs = { second: 1000, minute: 60_000, hour: 3600_000, day: 86_400_000 }[m[2] as "hour"];
  return { count: Number(m[1]), windowMs, text: value as string };
}

const asStringList = (v: unknown, field: string, errors: string[]): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    errors.push(`${field}: expected a list of strings`);
    return undefined;
  }
  return v as string[];
};

/** Parses and validates policy YAML. Unknown top-level keys are errors so typos don't silently weaken policy. */
export function parsePolicy(text: string): { policy?: Policy; errors: string[] } {
  const errors: string[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(text) as Record<string, unknown>;
  } catch (err) {
    return { errors: [`YAML syntax: ${(err as Error).message.split("\n")[0]}`] };
  }
  if (!raw || typeof raw !== "object") return { errors: ["policy must be a YAML mapping"] };

  const known = new Set(["org", "version", "registration", "isolation", "scopes", "links", "limits", "rules", "guard"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push(`unknown top-level key: ${k}`);

  const org = typeof raw.org === "string" && /^[a-z0-9][a-z0-9-]*$/.test(raw.org) ? raw.org : "";
  if (!org) errors.push("org: required, lowercase slug");

  const registration = (raw.registration ?? "approval") as Registration;
  if (!["approval", "invite", "open"].includes(registration)) errors.push("registration: approval, invite or open");
  const isolation = (raw.isolation ?? "links") as Isolation;
  if (!["links", "sessions"].includes(isolation)) errors.push("isolation: links or sessions");

  const scopes: Record<string, ScopeDef> = {};
  const rawScopes = (raw.scopes ?? {}) as Record<string, unknown>;
  if (typeof rawScopes !== "object" || Array.isArray(rawScopes)) errors.push("scopes: expected a mapping");
  else {
    for (const [name, def] of Object.entries(rawScopes)) {
      const d = def as Record<string, unknown>;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`scopes.${name}: name must be a lowercase slug`);
      if (!d || typeof d.description !== "string" || !d.description.trim()) {
        errors.push(`scopes.${name}.description: required`);
        continue;
      }
      scopes[name] = {
        description: d.description.trim(),
        keywords: asStringList(d.keywords, `scopes.${name}.keywords`, errors)?.map((k) => k.toLowerCase()),
      };
    }
  }
  if (Object.keys(scopes).length === 0) errors.push("scopes: define at least one scope");

  const links: LinkRule[] = [];
  const rawLinks = raw.links ?? [];
  if (!Array.isArray(rawLinks)) errors.push("links: expected a list");
  else {
    rawLinks.forEach((l: Record<string, unknown>, i: number) => {
      if (!l || typeof l.from !== "string" || typeof l.to !== "string") {
        errors.push(`links[${i}]: from and to are required`);
        return;
      }
      const s = asStringList(l.scopes, `links[${i}].scopes`, errors) ?? ["*"];
      for (const sc of s) if (sc !== "*" && !scopes[sc]) errors.push(`links[${i}].scopes: unknown scope "${sc}"`);
      links.push({ from: l.from, to: l.to, scopes: s, rate: parseRate(l.rate, `links[${i}].rate`, errors) });
    });
  }

  const rl = (raw.limits ?? {}) as Record<string, unknown>;
  const num = (k: string, d: number): number => {
    const v = rl[k];
    if (v === undefined) return d;
    if (typeof v !== "number" || v <= 0) {
      errors.push(`limits.${k}: expected a positive number`);
      return d;
    }
    return v;
  };
  const limits: Limits = {
    max_hops_per_thread: num("max_hops_per_thread", DEFAULT_LIMITS.max_hops_per_thread),
    max_messages_per_thread: num("max_messages_per_thread", DEFAULT_LIMITS.max_messages_per_thread),
    max_body_bytes: num("max_body_bytes", DEFAULT_LIMITS.max_body_bytes),
    message_ttl_ms: parseDuration(rl.message_ttl, "limits.message_ttl", errors) ?? DEFAULT_LIMITS.message_ttl_ms,
    max_blocks_per_hour: num("max_blocks_per_hour", DEFAULT_LIMITS.max_blocks_per_hour),
  };

  const rr = (raw.rules ?? {}) as Record<string, unknown>;
  const rules: Rules = {
    block: asStringList(rr.block, "rules.block", errors) ?? DEFAULT_RULES.block,
    hold: asStringList(rr.hold, "rules.hold", errors) ?? DEFAULT_RULES.hold,
    redact: asStringList(rr.redact, "rules.redact", errors) ?? DEFAULT_RULES.redact,
  };

  const rg = (raw.guard ?? {}) as Record<string, unknown>;
  const judge = (rg.judge ?? DEFAULT_GUARD.judge) as JudgeMode;
  if (!["auto", "anthropic", "claude-cli", "heuristic", "off"].includes(judge)) errors.push("guard.judge: auto, anthropic, claude-cli, heuristic or off");
  const minConf = rg.min_confidence ?? DEFAULT_GUARD.min_confidence;
  if (typeof minConf !== "number" || minConf < 0 || minConf > 1) errors.push("guard.min_confidence: number between 0 and 1");
  const onError = rg.on_error ?? DEFAULT_GUARD.on_error;
  if (onError !== "hold" && onError !== "block") errors.push("guard.on_error: hold or block (the guard never fails open)");
  const maxDecision = rg.max_decision ?? DEFAULT_GUARD.max_decision;
  if (maxDecision !== "hold" && maxDecision !== "block") errors.push("guard.max_decision: hold or block");
  const guard: GuardSettings = {
    judge,
    min_confidence: typeof minConf === "number" ? minConf : DEFAULT_GUARD.min_confidence,
    escalate: rg.escalate === undefined ? DEFAULT_GUARD.escalate : Boolean(rg.escalate),
    timeout_ms: parseDuration(rg.timeout, "guard.timeout", errors) ?? DEFAULT_GUARD.timeout_ms,
    on_error: onError as "hold" | "block",
    max_decision: maxDecision as "hold" | "block",
  };

  if (errors.length) return { errors };
  return { policy: { org, registration, isolation, scopes, links, limits, rules, guard }, errors };
}

const globCache = new Map<string, RegExp>();
export function matchAddress(pattern: string, address: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    globCache.set(pattern, re);
  }
  return re.test(address);
}

/** All link rules that let `from` message `to`. */
export function linksBetween(policy: Policy, from: string, to: string): LinkRule[] {
  return policy.links.filter((l) => matchAddress(l.from, from) && matchAddress(l.to, to));
}

export function linkFor(policy: Policy, from: string, to: string, scope: string): LinkRule | undefined {
  return linksBetween(policy, from, to).find((l) => l.scopes.includes("*") || l.scopes.includes(scope));
}

/** Which action the policy assigns to a finding category, or null when it is only a signal for the judge. */
export function actionFor(rules: Rules, category: string): "block" | "hold" | "redact" | null {
  if (rules.block.includes(category)) return "block";
  if (rules.hold.includes(category)) return "hold";
  if (rules.redact.includes(category)) return "redact";
  return null;
}
