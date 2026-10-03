// The provider adapters, against local servers that speak each wire protocol (and misspeak it in the ways real
// ones do): what is sent, how streams are read, how errors arrive.
import { createServer } from "http";
import { load, eq, ok, count } from "./harness-helpers.mjs";

const api = await load("src/api.ts");
const prof = await load("src/harness/model-profile.ts");
const {
  OpenAIProvider, AnthropicProvider, GeminiProvider, OllamaProvider,
  buildOpenAIPayload, buildAnthropicPayload, buildGeminiPayload, buildOllamaPayload, buildGeminiContents, buildAnthropicTurns, geminiSchema, ollamaOrigin,
} = api;

const config = (over = {}) => ({ id: "t", name: "T", type: "openai-compatible", baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m", extraHeaders: "", supportsWebSearch: false, supportsVision: true, ...over });
const profileOf = (cfg, extra = {}) => prof.resolveModelProfile({ providerId: cfg.id, providerType: cfg.type, baseUrl: cfg.baseUrl, model: cfg.model, supportsVision: cfg.supportsVision, ...extra });
const tool = (name, props = { path: { type: "string" } }) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false } });
const tools = [tool("read_note"), tool("search_notes", { query: { type: "string" } })];

// ── OpenAI: what is sent ──────────────────────────────────────────────────
{
  const cfg = config({ type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5" });
  const profile = profileOf(cfg);
  const p = buildOpenAIPayload({ config: cfg, profile, runtime: { temperature: 0.7 }, messages: [{ role: "user", content: "hi" }], tools, maxOutput: 100000 });
  eq([p.temperature, p.max_completion_tokens, p.max_tokens, !!p.stream_options, p.tool_choice], [undefined, 100000, undefined, true, "auto"], "gpt-5: no temperature, max_completion_tokens, usage asked for");
  const cfg2 = config({ model: "qwen3-32b" });
  const p2 = buildOpenAIPayload({ config: cfg2, profile: profileOf(cfg2), runtime: { temperature: 0.4, modelOptions: { max_tokens: 5, top_p: 0.9 } }, messages: [{ role: "user", content: "hi" }], tools: [], maxOutput: 8000 });
  eq([p2.temperature, p2.max_tokens, p2.max_completion_tokens, p2.top_p, p2.tools], [0.4, 8000, undefined, 0.9, undefined], "a compatible server: max_tokens, the user's other options, no tools sent when there are none");
  const noTools = buildOpenAIPayload({ config: cfg2, profile: { ...profileOf(cfg2), nativeTools: false }, runtime: {}, messages: [{ role: "user", content: "hi" }], tools, maxOutput: 100 });
  eq(noTools.tools, undefined, "a model learned not to take tools is not sent any");

  const thinking = config({ model: "deepseek-reasoner" });
  const history = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "", reasoning: "old thoughts", tool_calls: [{ id: "a", name: "read_note", arguments: "{}" }] },
    { role: "tool", content: "r", tool_call_id: "a" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "new question" },
    { role: "assistant", content: "", reasoning: "fresh thoughts", tool_calls: [{ id: "b", name: "read_note", arguments: "{}" }] },
    { role: "tool", content: "r2", tool_call_id: "b" },
  ];
  const dp = buildOpenAIPayload({ config: thinking, profile: profileOf(thinking), runtime: {}, messages: history, tools, maxOutput: 100 });
  eq(dp.messages.map((m) => m.reasoning_content), [undefined, undefined, undefined, undefined, undefined, "fresh thoughts", undefined], "thinking is sent back within the turn only");
  const official = config({ type: "openai", baseUrl: "https://api.openai.com/v1", model: "deepseek-reasoner" });
  const op = buildOpenAIPayload({ config: official, profile: profileOf(official), runtime: {}, messages: history, tools, maxOutput: 100 });
  eq(op.messages.some((m) => "reasoning_content" in m), false, "…and never to OpenAI itself");

  const withImage = buildOpenAIPayload({
    config: cfg, profile,
    runtime: {}, tools: [], maxOutput: 10,
    messages: [{ role: "user", content: "look", parts: [{ type: "image", mimeType: "image/png", data: "QUJD", name: "a.png" }, { type: "pdf", mimeType: "application/pdf", data: "UERG", name: "b.pdf" }] }],
  });
  eq(withImage.messages[0].content.map((c) => c.type), ["text", "image_url", "file"], "an image and a PDF are sent as parts");
  eq(withImage.messages[0].content[1].image_url.url, "data:image/png;base64,QUJD", "as data URIs");
  const blind = buildOpenAIPayload({ config: cfg2, profile: { ...profileOf(cfg2), vision: false }, runtime: {}, tools: [], maxOutput: 10, messages: [{ role: "user", content: "look", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] }] });
  eq(blind.messages[0].content, "look", "a model that cannot see is sent only the text");
}

// ── Anthropic: what is sent ───────────────────────────────────────────────
{
  const cfg = config({ type: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" });
  const profile = profileOf(cfg);
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "Let me check both.", tool_calls: [{ id: "t1", name: "read_note", arguments: '{"path":"a"}' }, { id: "t2", name: "search_notes", arguments: '{"query":"q"}' }] },
    { role: "tool", content: "A", tool_call_id: "t1", tool_name: "read_note" },
    { role: "tool", content: "Tool error: nope", tool_call_id: "t2", tool_name: "search_notes" },
    { role: "user", content: "Images returned by the tools above:", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }], metadata: { kind: "images" } },
  ];
  const turns = buildAnthropicTurns(messages, profile);
  eq(turns.map((t) => t.role), ["user", "assistant", "user"], "results of one round are one user turn");
  eq(turns[1].content.map((b) => b.type), ["text", "tool_use", "tool_use"], "the assistant's words stay with its calls");
  eq(turns[2].content.map((b) => b.type), ["tool_result", "tool_result", "image", "text"], "tool results come first, the images after");
  eq(turns[2].content[1].is_error, true, "a failed tool is marked as an error");
  const p = buildAnthropicPayload({ config: cfg, profile, runtime: { temperature: 1.7 }, messages, tools, maxOutput: 64000 });
  eq([p.max_tokens, p.temperature, p.system[0].text, p.system[0].cache_control.type], [64000, 1, "SYS", "ephemeral"], "the output limit, a temperature kept in range, a cached system prompt");
  eq(p.messages[p.messages.length - 1].content.at(-1).cache_control?.type, "ephemeral", "and the end of the conversation is a cache point");
  eq(p.tools[0].input_schema.type, "object", "tools use input_schema");
  const other = config({ type: "anthropic", baseUrl: "https://proxy.example/v1", model: "claude-sonnet-4-5" });
  const q = buildAnthropicPayload({ config: other, profile: profileOf(other), runtime: {}, messages, tools: [], maxOutput: 100 });
  eq([typeof q.system, JSON.stringify(q).includes("cache_control")], ["string", false], "a third-party endpoint gets no cache fields");
  const pdf = buildAnthropicTurns([{ role: "user", content: "read", parts: [{ type: "pdf", mimeType: "application/pdf", data: "UERG", name: "x.pdf" }] }], profile);
  eq(pdf[0].content.map((b) => b.type), ["document", "text"], "a PDF is a document block");
  const empty = buildAnthropicTurns([{ role: "user", content: "hi" }, { role: "assistant", content: "", tool_calls: [{ id: "x", name: "read_note", arguments: "" }] }], profile);
  eq(empty[1].content, [{ type: "tool_use", id: "x", name: "read_note", input: {} }], "no empty text block, empty arguments are {}");
}

// ── Gemini: what is sent ──────────────────────────────────────────────────
{
  const cfg = config({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-pro", supportsWebSearch: true });
  const profile = profileOf(cfg);
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "g1", name: "read_note", arguments: '{"path":"a"}', extra: { thoughtSignature: "SIG" } }, { id: "g2", name: "read_note", arguments: '{"path":"b"}' }] },
    { role: "tool", content: "A", tool_call_id: "g1", tool_name: "read_note" },
    { role: "tool", content: "B", tool_call_id: "g2", tool_name: "read_note" },
  ];
  const contents = buildGeminiContents(messages, profile);
  eq(contents.map((c) => c.role), ["user", "model", "user"], "roles alternate");
  eq(contents[1].parts.map((p) => !!p.functionCall), [true, true], "two calls of one tool are both kept");
  eq(contents[1].parts[0].thoughtSignature, "SIG", "the thought signature goes back with its call");
  eq(contents[2].parts.length, 2, "all results of a round are one turn with a part each");
  eq(contents[2].parts.map((p) => p.functionResponse.response.result), ["A", "B"], "in order");
  const p = buildGeminiPayload({ profile, runtime: { temperature: 0.5 }, config: cfg, messages, tools, maxOutput: 65536 });
  eq([p.generationConfig.maxOutputTokens, p.generationConfig.temperature], [65536, 0.5], "output limit and temperature");
  eq(p.tools.length, 1, "search grounding is not combined with function declarations");
  eq(JSON.stringify(p).includes("additionalProperties"), false, "unsupported schema keywords are removed");
  const noFns = buildGeminiPayload({ profile, runtime: {}, config: cfg, messages, tools: [], maxOutput: 10 });
  eq(Object.keys(noFns.tools[0]), ["googleSearch"], "with no functions, search grounding is offered");
  const s = geminiSchema({ type: ["string", "null"], enum: [1, 2], default: 3, properties: { a: { type: "OBJECT", additionalProperties: true } } });
  eq([s.type, s.nullable, s.enum, s.default], ["string", true, ["1", "2"], undefined], "a nullable type, string enums, no defaults");
  const noParams = buildGeminiPayload({ profile, runtime: {}, config: cfg, messages, tools: [{ name: "current_note", description: "d", parameters: { type: "object", properties: {} } }], maxOutput: 10 });
  eq("parameters" in noParams.tools[0].functionDeclarations[0], false, "a tool with no parameters declares none");
  const media = buildGeminiContents([{ role: "user", content: "see", parts: [{ type: "pdf", mimeType: "application/pdf", data: "UERG" }, { type: "audio", mimeType: "audio/mpeg", data: "QQ==" }] }], profile);
  eq(media[0].parts.map((p) => p.inlineData?.mimeType ?? "text"), ["application/pdf", "audio/mpeg", "text"], "PDF and audio go inline");
}

// ── Ollama: what is sent ──────────────────────────────────────────────────
{
  const cfg = config({ type: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" });
  const profile = profileOf(cfg, { localContextCap: undefined });
  eq(ollamaOrigin("http://localhost:11434/v1/"), "http://localhost:11434", "the /v1 is dropped");
  const p = buildOllamaPayload({ config: cfg, profile, runtime: { temperature: 0.3, modelOptions: { repetition_penalty: 1.1, max_tokens: 5 } }, messages: [
    { role: "system", content: "S" }, { role: "user", content: "hi", parts: [] },
    { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read_note", arguments: '{"path":"a"}' }] },
    { role: "tool", content: "A", tool_call_id: "1", tool_name: "read_note" },
  ], tools, maxOutput: 4000 });
  eq([p.options.num_ctx, p.options.num_predict, p.options.temperature, p.options.repeat_penalty, p.options.max_tokens], [32768, 4000, 0.3, 1.1, undefined], "the window is asked for explicitly");
  eq(p.messages[2].tool_calls[0].function.arguments, { path: "a" }, "arguments are an object");
  eq(p.messages[3], { role: "tool", content: "A", tool_name: "read_note" }, "a result names its tool");
}

// ── streams ───────────────────────────────────────────────────────────────
function serve(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      req.parsedBody = body ? JSON.parse(body) : {};
      handler(req, res);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const sse = (res, events, { done = true } = {}) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
};
async function collect(provider, messages, toolDefs = [], options) {
  const out = { text: "", reasoning: "", calls: [], finish: null, usage: null, error: null, done: false };
  await provider.chat(messages, toolDefs, {
    onToken: (t) => (out.text += t),
    onReasoning: (t) => (out.reasoning += t),
    onToolCalls: (c) => (out.calls = c),
    onFinish: (f) => (out.finish = f),
    onUsage: (u) => (out.usage = u),
    onDone: () => (out.done = true),
    onError: (e) => (out.error = e),
  }, options);
  return out;
}

// OpenAI-style streams.
{
  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push({ url: req.url, headers: req.headers, body: req.parsedBody });
    const mode = req.parsedBody.messages.at(-1).content;
    if (mode === "index") {
      sse(res, [
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo", reasoning_content: "hmm" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_note", arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "search_notes", arguments: '{"query":"q"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 10 } } },
      ]);
    } else if (mode === "whole") {
      // Some servers send each complete call as its own chunk, all at index 0 and each with its own id.
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_note", arguments: '{"path":"a"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "read_note", arguments: '{"path":"b"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    } else if (mode === "noids") {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read_note", arguments: { path: "z" } } }] } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    } else if (mode === "length") {
      sse(res, [{ choices: [{ delta: { content: "cut off" }, finish_reason: "length" }] }]);
    } else if (mode === "array") {
      sse(res, [{ choices: [{ delta: { content: [{ type: "text", text: "from parts" }] } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
    } else if (mode === "midstream") {
      sse(res, [{ choices: [{ delta: { content: "partial" } }] }, { error: { message: "upstream exploded", code: 502 } }]);
    } else if (mode === "429") {
      res.writeHead(429, { "Retry-After": "7", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
    } else if (mode === "toolsno") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "registry.ollama.ai/library/gemma3 does not support tools" } }));
    } else if (mode === "slow") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "tick" } }] })}\n\n`);
      req.on("close", () => (seen.closed = true));
    }
  });
  const provider = new OpenAIProvider(config({ baseUrl: url }));
  const ask = (text, opts) => collect(provider, [{ role: "user", content: text }], tools, opts);

  let r = await ask("index");
  eq([r.text, r.reasoning, r.done, r.error], ["Hello", "hmm", true, null], "text and thinking stream");
  eq(r.calls.map((c) => [c.id, c.name, c.arguments]), [["call_a", "read_note", '{"path":"x"}'], ["call_b", "search_notes", '{"query":"q"}']], "calls built from pieces by index");
  eq(r.finish.reason, "tool_calls", "finish reason");
  eq(r.usage, { inputTokens: 120, outputTokens: 30, cachedTokens: 100, reasoningTokens: 10 }, "usage from the last chunk");
  eq([seen[0].url, seen[0].headers.authorization, seen[0].body.stream_options, seen[0].body.max_tokens], ["/chat/completions", "Bearer k", { include_usage: true }, 32768], "what was sent: the unknown model's default limit, usage asked for");

  r = await ask("whole");
  eq(r.calls.map((c) => [c.id, c.arguments]), [["c1", '{"path":"a"}'], ["c2", '{"path":"b"}']], "whole calls at one index with different ids stay two calls");
  eq(r.finish.reason, "tool_calls", "a stop with calls is a tool_calls finish");
  r = await ask("noids");
  eq(r.calls.map((c) => [c.id, c.name, c.arguments]), [["call_1", "read_note", '{"path":"z"}']], "no id: one is made; object arguments are encoded");
  r = await ask("length");
  eq([r.text, r.finish.reason], ["cut off", "length"], "a cut-off answer says so");
  r = await ask("array");
  eq(r.text, "from parts", "content as parts is read");
  r = await ask("midstream");
  eq([r.text, r.error?.name, r.error?.status, r.error?.midStream], ["partial", "ProviderError", 502, true], "an error in the middle of a stream is an error");
  r = await ask("429");
  eq([r.error?.status, r.error?.retryAfterMs, r.done], [429, 7000, false], "a refusal carries its status and Retry-After");
  r = await ask("toolsno");
  ok(/does not support tools/.test(r.error.message), "the reason reaches the caller");

  // Stop closes the connection.
  const controller = new AbortController();
  const pending = ask("slow", { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 150));
  controller.abort();
  r = await pending;
  eq(r.error?.name, "AbortError", "an abort ends the request with an abort error");
  await new Promise((r) => setTimeout(r, 100));
  eq(!!seen.closed, true, "and the server sees the connection close");
  server.close();
}

// Anthropic streams.
{
  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push({ url: req.url, headers: req.headers, body: req.parsedBody });
    const mode = req.parsedBody.messages.at(-1).content[0].text;
    const events = {
      tools: [
        { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_note", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.md"}' } },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_2", name: "search_notes", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"q"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
        { type: "message_stop" },
      ],
      max: [
        { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "long long" } },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 64000 } },
      ],
      overloaded: [
        { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ],
      thinking: [
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
      ],
    }[mode];
    if (mode === "toolarge") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-20250514" } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  const provider = new AnthropicProvider(config({ type: "anthropic", baseUrl: url, model: "claude-sonnet-4-5" }));
  const ask = (text) => collect(provider, [{ role: "system", content: "S" }, { role: "user", content: text }], tools);
  let r = await ask("tools");
  eq(r.text, "Checking", "text streams");
  eq(r.calls.map((c) => [c.id, c.name, c.arguments]), [["tu_1", "read_note", '{"path":"a.md"}'], ["tu_2", "search_notes", '{"query":"q"}']], "tool_use blocks by index");
  eq([r.finish.reason, r.usage], ["tool_calls", { inputTokens: 100, outputTokens: 42, cachedTokens: 90 }], "stop reason and usage (cache reads count as input)");
  eq([seen[0].headers["x-api-key"], seen[0].headers["anthropic-version"], seen[0].body.max_tokens], ["k", "2023-06-01", 64000], "headers and the model's own maximum");
  r = await ask("max");
  eq(r.finish.reason, "length", "max_tokens is a length finish");
  r = await ask("overloaded");
  eq([r.text, r.error?.status, r.error?.midStream], ["part", 529, true], "an error event becomes an overloaded error");
  r = await ask("thinking");
  eq([r.reasoning, r.text, r.finish.reason], ["pondering", "done", "stop"], "thinking deltas are reasoning");
  r = await ask("toolarge");
  ok(/maximum allowed number of output tokens/.test(r.error.message) && r.error.status === 400, "the output-limit error is passed on");
  server.close();
}

// Gemini streams.
{
  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push({ url: req.url, headers: req.headers, body: req.parsedBody });
    const mode = req.parsedBody.contents.at(-1).parts[0].text;
    const chunks = {
      tools: [
        { candidates: [{ content: { parts: [{ text: "ok " }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: "read_note", args: { path: "a" } }, thoughtSignature: "SIG1" }, { functionCall: { name: "read_note", args: { path: "b" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, thoughtsTokenCount: 20, cachedContentTokenCount: 10 } },
      ],
      malformed: [{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }],
      max: [{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }],
      thought: [{ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: "answer" }] } }] }],
      blocked: [{ promptFeedback: { blockReason: "SAFETY" } }],
    }[mode];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
    res.end();
  });
  const provider = new GeminiProvider(config({ type: "gemini", baseUrl: url, model: "gemini-2.5-pro" }));
  const ask = (text) => collect(provider, [{ role: "user", content: text }], tools);
  let r = await ask("tools");
  eq(r.text, "ok ", "text");
  eq(r.calls.map((c) => [c.id, c.name, c.arguments, c.extra]), [["gemini-call-1", "read_note", '{"path":"a"}', { thoughtSignature: "SIG1" }], ["gemini-call-2", "read_note", '{"path":"b"}', undefined]], "two calls of one tool stay two, with unique ids and their signatures");
  eq(r.usage, { inputTokens: 50, outputTokens: 28, cachedTokens: 10, reasoningTokens: 20 }, "usage, thinking counted as output");
  eq([seen[0].headers["x-goog-api-key"], seen[0].url.includes("key="), seen[0].url.startsWith("/models/gemini-2.5-pro:streamGenerateContent")], ["k", false, true], "the key travels in a header, not in the URL");
  r = await ask("malformed");
  eq(r.finish.reason, "malformed", "a malformed function call is reported as such");
  r = await ask("max");
  eq(r.finish.reason, "length", "MAX_TOKENS");
  r = await ask("thought");
  eq([r.reasoning, r.text], ["thinking…", "answer"], "thought parts are reasoning");
  r = await ask("blocked");
  ok(/blocked/.test(r.error.message), "a blocked prompt is an error");
  server.close();
}

// Ollama.
{
  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push({ url: req.url, body: req.parsedBody });
    if (req.url !== "/api/chat") { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const lines = [
      { message: { role: "assistant", thinking: "hm" } },
      { message: { role: "assistant", content: "Hi" } },
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_note", arguments: { path: "a" } } }, { function: { name: "read_note", arguments: { path: "b" } } }] } },
      { done: true, done_reason: "stop", prompt_eval_count: 77, eval_count: 5 },
    ];
    for (const l of lines) res.write(JSON.stringify(l) + "\n");
    res.end();
  });
  const provider = new OllamaProvider(config({ type: "ollama", baseUrl: `${url}/v1`, model: "llama3.1" }));
  const r = await collect(provider, [{ role: "user", content: "hi" }], tools);
  eq([r.text, r.reasoning, r.done], ["Hi", "hm", true], "NDJSON text and thinking");
  eq(r.calls.map((c) => [c.id, c.arguments]), [["ollama-call-1", '{"path":"a"}'], ["ollama-call-2", '{"path":"b"}']], "complete calls, with ids made up");
  eq(r.usage, { inputTokens: 77, outputTokens: 5 }, "usage from the final line");
  eq([seen[0].url, seen[0].body.options.num_ctx, seen[0].body.options.num_predict], ["/api/chat", 32768, 31744], "the native endpoint, with the window asked for and the room that leaves");
  server.close();

  // Not really Ollama: the same port answers only the OpenAI protocol.
  const fake = await serve((req, res) => {
    if (req.url === "/api/chat") { res.writeHead(404); return res.end("404 page not found"); }
    seen.push({ url: req.url });
    sse(res, [{ choices: [{ delta: { content: "from the OpenAI route" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  });
  const p2 = new OllamaProvider(config({ type: "ollama", baseUrl: `${fake.url}/v1`, model: "llama3.1" }));
  const r2 = await collect(p2, [{ role: "user", content: "hi" }], []);
  eq(r2.text, "from the OpenAI route", "a server that has no /api/chat is spoken to in OpenAI");
  fake.server.close();
}

console.log(`HARNESS_PROVIDERS_OK (${count()} checks)`);
