// ── harness/wire.ts ───────────────────────────────────────────────────────
// The connection to a provider: a streamed POST read as server-sent events
// (or newline-delimited JSON, which is what Ollama speaks). Three things the
// first version of this got wrong matter to a model that thinks for a while:
//
//   - A thinking model may send nothing at all for minutes before its first
//     token. A fixed two-minute idle timer killed those requests, so the
//     wait for the first byte is long and only the silence after it is short.
//   - Pressing Stop only stopped listening; the request went on running (and
//     being billed). An abort signal now closes the connection.
//   - A failed request threw a string. It now throws an error that carries
//     the status, the body and the Retry-After the provider sent, so the
//     caller can decide between waiting, shrinking the request and giving up.
// ─────────────────────────────────────────────────────────────────────────────

import { request as httpRequest, IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import { requestUrl } from "obsidian";
import { AbortedError, ProviderError, parseRetryAfter } from "./errors";

export interface WireOptions {
  signal?: AbortSignal;
  /** How long to wait for the first byte of the answer. */
  firstByteTimeoutMs?: number;
  /** How long a started answer may go quiet. */
  idleTimeoutMs?: number;
  /** Lines are JSON objects, not `data:` events. */
  ndjson?: boolean;
}

export const FIRST_BYTE_TIMEOUT_MS = 10 * 60_000;
export const REASONING_FIRST_BYTE_TIMEOUT_MS = 30 * 60_000;
export const IDLE_TIMEOUT_MS = 3 * 60_000;

function dataOf(line: string, ndjson: boolean): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (ndjson) return trimmed;
  if (!trimmed.startsWith("data:")) return null;
  return trimmed.slice(5).trim();
}

/** Direct Node streaming, so the first token appears when the model writes it. */
export async function* nativeNodeStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: WireOptions = {}
): AsyncGenerator<string> {
  if (opts.signal?.aborted) throw new AbortedError();
  const target = new URL(url);
  const requestFn = target.protocol === "http:" ? httpRequest : httpsRequest;
  const firstByte = opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const idle = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  let req: ReturnType<typeof httpRequest> | undefined;
  let started = false;
  const onAbort = () => req?.destroy(new AbortedError());
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    req = requestFn(
      target,
      {
        method: "POST",
        headers: {
          Accept: opts.ndjson ? "application/x-ndjson, application/json" : "text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        started = true;
        resolve(res);
      }
    );
    req.once("error", reject);
    req.setTimeout(firstByte, () => {
      // Once the answer has begun the idle timer below takes over.
      if (started) return;
      req?.destroy(new ProviderError(`Provider request timed out: no answer after ${Math.round(firstByte / 1000)} seconds.`, { code: "ETIMEDOUT" }));
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.write(body);
    req.end();
  });

  try {
    const status = response.statusCode ?? 500;
    if (status >= 400) {
      let errorBody = "";
      for await (const chunk of response) {
        errorBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (errorBody.length > 4000) break;
      }
      throw new ProviderError(`Provider error (${status}): ${errorBody.slice(0, 800)}`, {
        status,
        body: errorBody,
        retryAfterMs: parseRetryAfter(response.headers["retry-after"] ?? response.headers["retry-after-ms"]),
      });
    }

    // From here the answer has begun: only silence is an error.
    response.socket?.setTimeout(idle);
    response.socket?.once("timeout", () => {
      response.destroy(new ProviderError(`Provider stopped answering for ${Math.round(idle / 1000)} seconds.`, { code: "ETIMEDOUT" }));
    });

    let buffer = "";
    try {
      for await (const chunk of response) {
        buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = dataOf(line, !!opts.ndjson);
          if (data === null) continue;
          if (data === "[DONE]") { yield data; return; }
          if (data) yield data;
        }
      }
    } catch (error) {
      if (opts.signal?.aborted) throw new AbortedError();
      const wrapped = error instanceof ProviderError ? error : new ProviderError(String((error as Error)?.message ?? error), { code: (error as { code?: string })?.code });
      wrapped.midStream = true;
      throw wrapped;
    }

    const trailing = dataOf(buffer, !!opts.ndjson);
    if (trailing) yield trailing;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Streaming through Obsidian's own `requestUrl`: not subject to CORS and
 * following the system proxy, but it returns the whole body at once where a
 * streamed body is not available. Used when the direct connection fails
 * before anything arrives.
 */
export async function* obsidianStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: WireOptions = {}
): AsyncGenerator<string> {
  if (opts.signal?.aborted) throw new AbortedError();
  let resp: any;
  try {
    resp = await requestUrl({ url, method: "POST", headers, body, contentType: "application/json" } as any);
  } catch (error: any) {
    const status = typeof error?.status === "number" ? error.status : undefined;
    throw new ProviderError(status ? `Provider error (${status}): ${String(error?.message ?? error).slice(0, 800)}` : String(error?.message ?? error), {
      status,
      body: String(error?.message ?? ""),
    });
  }
  const raw: any = resp;
  if (typeof raw.status === "number" && raw.status >= 400) {
    throw new ProviderError(`Provider error (${raw.status}): ${String(raw.text ?? "").slice(0, 800)}`, {
      status: raw.status,
      body: String(raw.text ?? ""),
      retryAfterMs: parseRetryAfter(raw.headers?.["retry-after"]),
    });
  }
  if (raw.body && typeof raw.body.getReader === "function") {
    const reader = raw.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      if (opts.signal?.aborted) { try { await reader.cancel(); } catch { /* closed */ } throw new AbortedError(); }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = dataOf(line, !!opts.ndjson);
        if (data === null) continue;
        if (data === "[DONE]") { yield data; return; }
        if (data) yield data;
      }
    }
    const trailing = dataOf(buffer, !!opts.ndjson);
    if (trailing) yield trailing;
    return;
  }

  // Buffered body: the stream is parsed after the fact, with a breath between events so the screen still moves.
  const text: string = raw.text ?? "";
  for (const line of text.split("\n")) {
    if (opts.signal?.aborted) throw new AbortedError();
    const data = dataOf(line, !!opts.ndjson);
    if (data === null) continue;
    if (data === "[DONE]") { yield data; return; }
    if (data) {
      yield data;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/** Tries the direct connection first; falls back to Obsidian's only if it failed before anything arrived. */
export async function* streamEvents(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: WireOptions = {}
): AsyncGenerator<string> {
  let emitted = false;
  try {
    for await (const data of nativeNodeStream(url, headers, body, opts)) {
      emitted = true;
      yield data;
    }
  } catch (error: any) {
    if (emitted || error instanceof ProviderError && (error.status !== undefined || error.code === "ETIMEDOUT") || error?.name === "AbortError") throw error;
    yield* obsidianStream(url, headers, body, opts);
  }
}
