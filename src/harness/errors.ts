// ── harness/errors.ts ─────────────────────────────────────────────────────
// What went wrong with a request, in terms that decide what to do next. A
// rate limit, an overloaded server and a dropped connection are tried again
// after a wait; a request that was too large is made smaller and tried
// again; a parameter the model does not take is left out and tried again; a
// wrong key is reported at once. Telling these apart from one another is the
// difference between an agent that carries on and one that stops on the
// first hiccup.
// ─────────────────────────────────────────────────────────────────────────────

import { UnsupportedParam, parseContextOverflow, parseOutputLimit, parseUnsupportedParam } from "./model-profile";

export class ProviderError extends Error {
  status?: number;
  body?: string;
  retryAfterMs?: number;
  code?: string;
  /** Set when the connection failed after the provider had started answering. */
  midStream = false;

  constructor(message: string, init: { status?: number; body?: string; retryAfterMs?: number; code?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = init.status;
    this.body = init.body;
    this.retryAfterMs = init.retryAfterMs;
    this.code = init.code;
  }
}

export class AbortedError extends Error {
  constructor() {
    super("The request was stopped.");
    this.name = "AbortError";
  }
}

export type ErrorKind =
  | "aborted"
  | "rate_limit"
  | "quota"
  | "overloaded"
  | "server"
  | "network"
  | "refused"
  | "timeout"
  | "context_overflow"
  | "output_limit"
  | "unsupported_param"
  | "auth"
  | "not_found"
  | "bad_request"
  | "other";

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
  /** For context_overflow: the window, if the message says. */
  contextLimit?: number;
  /** For context_overflow: what the input alone came to, if the message says. */
  inputTokens?: number;
  /** For output_limit: the model's real maximum. */
  outputLimit?: number;
  param?: UnsupportedParam;
  /** Worth sending again as it is, after a wait. */
  transient: boolean;
}

/** A retry-after given in seconds, in milliseconds, as an HTTP date, or in the body as "try again in 20s". */
export function parseRetryAfter(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  const m = /(?:retry|try again)[^\d]{0,20}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] ?? "s").toLowerCase();
    if (unit.startsWith("ms") || unit.startsWith("milli")) return Math.round(n);
    if (unit.startsWith("m") && !unit.startsWith("ms")) return Math.round(n * 60_000);
    return Math.round(n * 1000);
  }
  return undefined;
}

export function classifyError(error: unknown, ctx: { requestedOutput?: number } = {}): ClassifiedError {
  const e = error as { name?: string; message?: string; status?: number; retryAfterMs?: number; code?: string; body?: string } | undefined;
  const message = String(e?.message ?? error ?? "Unknown error");
  const body = String(e?.body ?? "");
  const text = `${message}\n${body}`;
  const status = typeof e?.status === "number" ? e.status : /\((\d{3})\)/.exec(message)?.[1] ? Number(/\((\d{3})\)/.exec(message)![1]) : undefined;
  const retryAfterMs = e?.retryAfterMs ?? parseRetryAfter(body || message);
  const base = { message, status, retryAfterMs };

  // Only our own abort is an abort; "aborted" from the socket layer means the other end hung up.
  if (e?.name === "AbortError") return { ...base, kind: "aborted", transient: false };

  const overflow = status === 400 || status === 413 || status === 422 || status === undefined ? parseContextOverflow(text) : null;
  if (overflow) return { ...base, kind: "context_overflow", contextLimit: overflow.limit, inputTokens: overflow.input, transient: false };

  if (status === undefined || (status >= 400 && status < 500)) {
    const out = parseOutputLimit(text, ctx.requestedOutput);
    if (out) return { ...base, kind: "output_limit", outputLimit: out, transient: false };
    const param = parseUnsupportedParam(text);
    if (param) return { ...base, kind: "unsupported_param", param, transient: false };
  }

  if (/insufficient[_ ]quota|exceeded your current quota|billing|credit balance|out of credits|payment required|insufficient (credits|balance|funds)/i.test(text) || status === 402) {
    return { ...base, kind: "quota", transient: false };
  }
  if (status === 429 || /rate[ _-]?limit|too many requests|resource_exhausted|tokens per minute|requests per minute/i.test(text)) {
    return { ...base, kind: "rate_limit", transient: true };
  }
  if (status === 529 || /overloaded/i.test(text)) return { ...base, kind: "overloaded", transient: true };
  if (status === 401 || status === 403) return { ...base, kind: "auth", transient: false };
  if (status === 404 || /model .*(not found|does not exist)|unknown model|no such model/i.test(text)) return { ...base, kind: "not_found", transient: false };
  if (status !== undefined && status >= 500) return { ...base, kind: "server", transient: true };
  if (e?.code === "ECONNREFUSED" || /ECONNREFUSED|connection refused/i.test(text)) return { ...base, kind: "refused", transient: true };
  if (/timed out|ETIMEDOUT|timeout/i.test(text)) return { ...base, kind: "timeout", transient: true };
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|stream (was )?(closed|disconnected|ended)|premature close|terminated|\baborted\b/i.test(text)) {
    return { ...base, kind: "network", transient: true };
  }
  if (status !== undefined && status >= 400) return { ...base, kind: "bad_request", transient: false };
  return { ...base, kind: "other", transient: false };
}

/** How long to wait before attempt number `attempt` (1-based), honouring what the provider asked for. */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponential = Math.min(20_000, 1_000 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 400);
  const wanted = retryAfterMs !== undefined ? Math.min(60_000, Math.max(retryAfterMs, 500)) : exponential;
  return wanted + jitter;
}

/** A sentence a person can act on. */
export function explainError(c: ClassifiedError, provider: string): string {
  switch (c.kind) {
    case "auth": return `${provider} refused the credentials. Check the API key in Agenter's settings.`;
    case "quota": return `${provider} says the account is out of quota or credit. Add credit or switch provider.`;
    case "rate_limit": return `${provider} is limiting requests and kept refusing after several waits.`;
    case "overloaded": return `${provider} is overloaded right now and kept refusing after several waits.`;
    case "refused": return `Could not connect to ${provider}. If it runs on your own machine, is it running?`;
    case "not_found": return `${provider} does not know this model. Pick another in the model menu.`;
    case "timeout": return `${provider} stopped answering. Try again, or use a faster model.`;
    case "network": return `The connection to ${provider} dropped and kept dropping.`;
    default: return c.message;
  }
}
