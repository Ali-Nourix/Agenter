// The harness's pure parts: token estimates, model profiles and what error messages teach, JSON and tool-call
// repair, conversation sanitizing, tool output limits, context compaction, error classification.
import { load, eq, ok, near, count } from "./harness-helpers.mjs";

const h = await load("test/harness-entry.ts");

// ── tokens ────────────────────────────────────────────────────────────────
const english = "The quick brown fox jumps over the lazy dog. ".repeat(20);
near(h.estimateTextTokens(english), english.length / 3.6, 2, "English: about 3.6 characters a token");
ok(h.estimateTextTokens("سلام دنیا، این یک متن فارسی است که توکن‌های بیشتری مصرف می‌کند") > 22, "Persian costs more per character");
const persian = "این یک جمله فارسی است ".repeat(10);
ok(h.estimateTextTokens(persian) > persian.length / 3.6 * 1.4, "Persian is counted well above Latin");
eq(h.estimateTextTokens("你好世界"), 4, "CJK: one token a character");
eq(h.estimateTextTokens(""), 0, "nothing is nothing");
eq(h.formatTokens(999), "999", "format: small");
eq(h.formatTokens(12_345), "12k", "format: thousands");
eq(h.formatTokens(200_000), "200k", "format: 200k");
eq(h.formatTokens(1_048_576), "1.05M", "format: a million");
eq(h.formatTokens(2_000_000), "2M", "format: two million");
{
  const c = new h.TokenCalibrator();
  eq(c.ratio("m"), 1, "calibration starts at 1");
  c.observe("m", 1000, 1500);
  near(c.ratio("m"), 1.5, 0.001, "the first report sets the ratio");
  c.observe("m", 1000, 1000);
  near(c.ratio("m"), 1.3, 0.001, "later ones move it slowly");
  c.observe("m", 100, 5000);
  near(c.ratio("m"), 1.3, 0.001, "a tiny estimate is not learned from");
  eq(c.apply("m", 1000), 1300, "the ratio is applied");
  c.observe("m", 1000, 100000);
  ok(c.ratio("m") <= 3, "the ratio is bounded");
}

// ── a model that stops in the middle of the job ──────────────────────────
{
  const why = (text, opts) => h.assessAnswer(text, opts)?.reason ?? null;
  // Announced, not done.
  eq(why("Sure. First I will write the middle sections, then the rest."), "announced", "an announced next step");
  eq(why("I'll prepare the sections one by one for you. First, the middle sections:"), "colon", "a sentence that ends where its content should begin");
  eq(why("من برای اینکه متن کامل را بدهم، بخش‌ها را تکتک آماده می‌کنم. ابتدا بخش‌های میانی را ارائه می‌دهم."), "announced", "the same, in Persian");
  eq(why("حالا بخش بعدی را برایتان می‌نویسم:"), "colon", "a Persian announcement of the next part");
  // Asked for permission to go on.
  eq(why("Here is part one.\n\nShall I continue with the next section?"), "asks-to-continue", "a question whether to go on");
  eq(why("بخش اول تمام شد. آیا ادامه بدهم؟"), "asks-to-continue", "…in Persian");
  eq(why("Reply \"continue\" and I will send the rest."), "asks-to-continue", "a request to say continue");
  eq(why("Here is the first half of the text… (1/3)"), "part-marker", "a part marker");
  // Cut off.
  eq(why("```js\nfunction a() {\n  return 1;"), "open-fence", "a block of code that was never closed");
  eq(why("The report finds that revenue grew because of the", {}), "cut-off", "a sentence that ends on a connecting word");
  eq(why("The report finds that revenue grew in the second half", { hitOutputLimit: true }), "cut-off", "whatever the end, when the whole output limit was used");
  eq(why("و نتیجه گرفتیم که این روش با"), "cut-off", "…in Persian");
  // Finished, and left alone.
  eq(why("Revenue grew 12% quarter over quarter."), null, "a plain answer");
  eq(why("I will write less."), null, "a remark is not an announcement");
  eq(why("Done. Let me know if you need anything else."), null, "a closing line is not an announcement");
  eq(why("Which of the two notes do you mean?"), null, "a question the model needs answered is left alone");
  eq(why("همه چیز انجام شد. اگر نیاز به تغییر داشتید بگویید."), null, "a Persian closing line");
  eq(why("```js\nconst a = 1;\n```\nThat is the whole function."), null, "a closed block of code");
  eq(why("I'll read the file.", { midWork: true }), "announced", "in the middle of work, a bare announcement is the model stopping");
  eq(why("I'll read the file."), null, "…and outside it, it is not");
  ok(h.addedLittle("Done.") && !h.addedLittle("x".repeat(200)), "a continuation that adds almost nothing is the end of it");
  ok(/Do not repeat/.test(h.continuationPrompt("cut-off")) && /next part/.test(h.continuationPrompt("part-marker")), "each way of stopping gets its own words");
}

// ── model profiles ────────────────────────────────────────────────────────
const base = { providerId: "p", providerType: "openai-compatible", baseUrl: "https://x/v1" };
{
  const p = h.resolveModelProfile({ ...base, providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" });
  eq([p.contextWindow, p.maxOutput, p.outputParam, p.acceptsTemperature, p.family], [128000, 16384, "max_completion_tokens", true, "openai"], "gpt-4o");
  const o = h.resolveModelProfile({ ...base, providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "o3-mini" });
  eq([o.reasoning, o.acceptsTemperature, o.maxOutput], [true, false, 100000], "o3-mini thinks and takes no temperature");
  const g5 = h.resolveModelProfile({ ...base, providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" });
  eq([g5.contextWindow, g5.maxOutput, g5.acceptsTemperature], [400000, 128000, false], "gpt-5");
  const chat = h.resolveModelProfile({ ...base, providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-chat-latest" });
  eq([chat.contextWindow, chat.acceptsTemperature], [128000, true], "gpt-5-chat is not a reasoning model");
  const cl = h.resolveModelProfile({ ...base, providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" });
  eq([cl.contextWindow, cl.maxOutput, cl.family, cl.pdfNative, cl.vision], [200000, 64000, "anthropic", true, true], "claude sonnet 4.5");
  const op = h.resolveModelProfile({ ...base, providerType: "anthropic", model: "claude-opus-4-20250514" });
  eq(op.maxOutput, 32000, "opus 4 writes less");
  const old = h.resolveModelProfile({ ...base, providerType: "anthropic", model: "claude-3-haiku-20240307" });
  eq(old.maxOutput, 4096, "claude 3 haiku");
  const gemma = (id) => h.resolveModelProfile({ ...base, model: id }).contextWindow;
  eq([gemma("@cf/google/gemma-4-26b-a4b-it"), gemma("gemma-3-12b-it"), gemma("gemma3:27b")], [128000, 128000, 128000], "Gemma 3 and later read 128k, not 8k");
  eq([gemma("gemma-3n-e4b"), gemma("@hf/google/gemma-7b-it"), gemma("gemma-2-9b-it"), gemma("gemma-2b")], [32768, 8192, 8192, 8192], "…while the first generations and 3n keep their own windows");
  const gem = h.resolveModelProfile({ ...base, providerType: "gemini", model: "gemini-2.5-pro" });
  eq([gem.contextWindow, gem.maxOutput, gem.pdfNative], [1048576, 65536, true], "gemini 2.5 pro");
  const ds = h.resolveModelProfile({ ...base, model: "deepseek-reasoner" });
  eq([ds.reasoning, ds.passReasoningBack, ds.maxOutput], [true, true, 64000], "deepseek-reasoner wants its thinking back");
  const dsOfficial = h.resolveModelProfile({ ...base, providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "deepseek-reasoner" });
  eq(dsOfficial.passReasoningBack, false, "never sent to OpenAI itself");
  const unk = h.resolveModelProfile({ ...base, model: "some-new-model" });
  eq([unk.contextWindow, unk.contextSource, unk.maxOutput, unk.outputSource, unk.outputParam], [128000, "default", 32768, "default", "max_tokens"], "an unknown model starts from defaults");
  const cat = h.resolveModelProfile({ ...base, model: "some-new-model", catalog: { contextLength: 65536, maxOutputTokens: 8192, capabilities: {} } });
  eq([cat.contextWindow, cat.contextSource, cat.maxOutput, cat.outputSource], [65536, "catalog", 8192, "catalog"], "the catalog is believed over defaults");
  const learned = h.resolveModelProfile({ ...base, model: "gpt-4o", learned: { contextWindow: 32000, contextSource: "learned", maxOutput: 4000, outputSource: "learned", acceptsTemperature: false, nativeTools: false, updatedAt: 1 }, catalog: { contextLength: 128000, capabilities: {} } });
  eq([learned.contextWindow, learned.contextSource, learned.maxOutput, learned.acceptsTemperature, learned.nativeTools], [32000, "learned", 4000, false, false], "what was learned beats the catalog and the table");
  const overridden = h.resolveModelProfile({ ...base, model: "gpt-4o", learned: { contextWindow: 32000, updatedAt: 1 }, override: { contextWindow: 50000, maxOutput: 6000 } });
  eq([overridden.contextWindow, overridden.contextSource, overridden.maxOutput], [50000, "override", 6000], "the person's number beats everything");
  const tiny = h.resolveModelProfile({ ...base, model: "x", override: { contextWindow: 4096, maxOutput: 100000 } });
  ok(tiny.maxOutput < 4096, "an answer can never be longer than the window");
  const oll = h.resolveModelProfile({ ...base, providerType: "ollama", model: "llama3.1" });
  eq([oll.contextWindow, oll.numCtx, oll.modelMaxContext], [32768, 32768, 131072], "Ollama is asked for 32k by default");
  const ollFull = h.resolveModelProfile({ ...base, providerType: "ollama", model: "llama3.1", localContextCap: 0 });
  eq([ollFull.contextWindow, ollFull.numCtx], [131072, 131072], "or the model's whole window when asked");
  const ollLearned = h.resolveModelProfile({ ...base, providerType: "ollama", model: "llama3.1", localContextCap: 0, learned: { numCtx: 16384, updatedAt: 1 } });
  eq(ollLearned.numCtx, 16384, "and never more than it managed to load");
  eq(h.outputLimitFor(p, undefined), 16384, "no manual limit: the model's maximum");
  eq(h.outputLimitFor(p, 1000), 1000, "a manual limit below the maximum");
  eq(h.outputLimitFor(p, 99999), 16384, "a manual limit above it is held to it");
}

// ── what error messages teach ─────────────────────────────────────────────
{
  const overflow = [
    ["This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens. Please reduce the length of the messages.", 128000],
    ["prompt is too long: 210000 tokens > 200000 maximum", 200000],
    ["input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again", 200000],
    ["The input token count (1100000) exceeds the maximum number of tokens allowed (1048575).", 1048575],
    ["This endpoint's maximum context length is 32768 tokens. However, you requested about 40000 tokens (35000 of text input, 5000 in the output).", 32768],
    ["This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (4500 in the messages, 500 in the completion).", 4096],
    ["Prompt contains 140000 tokens ... too large for model with 131072 maximum context length", 131072],
    ["Request too large for model: context length is 8192 tokens", 8192],
  ];
  for (const [message, limit] of overflow) {
    const r = h.parseContextOverflow(message);
    ok(r, `overflow recognised: ${message.slice(0, 40)}`);
    eq(r.limit, limit, `window found in: ${message.slice(0, 50)}`);
  }
  eq(h.parseContextOverflow("Invalid API key"), null, "not an overflow");
  eq(h.parseContextOverflow("max_tokens must be <= 8192"), null, "an output limit is not an overflow");

  const output = [
    ["max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-20250514", 64000, 32000],
    ["max_tokens is too large: 100000. This model supports at most 16384 completion tokens, whereas you provided 100000.", 100000, 16384],
    ["Invalid max_tokens value, the valid range of max_tokens is [1, 8192]", 32768, 8192],
    ["`max_tokens` must be <= 4096", 32768, 4096],
    ["Unable to submit request because it has a maxOutputTokens value of 100000 but the supported range is from 1 (inclusive) to 8193 (exclusive).", 100000, 8192],
    ["max_completion_tokens is too large: 200000. This model supports at most 100000 completion tokens", 200000, 100000],
  ];
  for (const [message, requested, limit] of output) {
    eq(h.parseOutputLimit(message, requested), limit, `output limit found in: ${message.slice(0, 50)}`);
  }
  eq(h.parseOutputLimit("The model is overloaded", 4000), null, "an unrelated error teaches nothing");

  eq(h.parseUnsupportedParam("Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported."), "temperature", "temperature refused");
  eq(h.parseUnsupportedParam("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), "max_tokens", "max_tokens refused");
  eq(h.parseUnsupportedParam("Unrecognized request argument supplied: max_completion_tokens"), "max_completion_tokens", "max_completion_tokens refused");
  eq(h.parseUnsupportedParam("registry.ollama.ai/library/gemma3 does not support tools"), "tools", "no tools");
  eq(h.parseUnsupportedParam("No endpoints found that support tool use."), "tools", "no tools (OpenRouter)");
  eq(h.parseUnsupportedParam("Unrecognized request argument supplied: stream_options"), "stream_options", "stream_options refused");
  eq(h.parseUnsupportedParam("Something else"), null, "nothing recognised");
}

// ── error classification ──────────────────────────────────────────────────
{
  const e = (message, extra = {}) => Object.assign(new Error(message), extra);
  eq(h.classifyError(e("Provider error (429): slow down", { status: 429, retryAfterMs: 7000 })).kind, "rate_limit", "429");
  eq(h.classifyError(e("Provider error (429): slow down", { status: 429, retryAfterMs: 7000 })).retryAfterMs, 7000, "Retry-After kept");
  eq(h.classifyError(e("Provider error (529): Overloaded", { status: 529 })).kind, "overloaded", "529");
  eq(h.classifyError(e("Provider error (503): unavailable", { status: 503 })).transient, true, "503 is temporary");
  eq(h.classifyError(e("Provider error (401): bad key", { status: 401 })).kind, "auth", "401");
  eq(h.classifyError(e("Provider error (402): payment required", { status: 402 })).kind, "quota", "402");
  eq(h.classifyError(e("Provider error (429): You exceeded your current quota, please check your plan and billing details.", { status: 429 })).kind, "quota", "quota is not a rate limit");
  eq(h.classifyError(e("read ECONNRESET", { code: "ECONNRESET" })).kind, "network", "reset");
  eq(h.classifyError(e("connect ECONNREFUSED 127.0.0.1:11434", { code: "ECONNREFUSED" })).kind, "refused", "refused");
  eq(h.classifyError(e("Provider request timed out: no answer after 600 seconds.")).kind, "timeout", "timeout");
  eq(h.classifyError(new h.AbortedError()).kind, "aborted", "aborted");
  const ov = h.classifyError(e("Provider error (400): prompt is too long: 210000 tokens > 200000 maximum", { status: 400 }));
  eq([ov.kind, ov.contextLimit], ["context_overflow", 200000], "overflow with its window");
  const ol = h.classifyError(e("Provider error (400): max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4", { status: 400 }), { requestedOutput: 64000 });
  eq([ol.kind, ol.outputLimit], ["output_limit", 32000], "output limit with its number");
  eq(h.classifyError(e("Provider error (404): model not found", { status: 404 })).kind, "not_found", "unknown model");
  eq(h.parseRetryAfter("12"), 12000, "seconds");
  eq(h.parseRetryAfter("Please try again in 1.5s"), 1500, "in the body");
  eq(h.parseRetryAfter("try again in 2 minutes"), 120000, "minutes");
  ok(h.retryDelayMs(1) >= 1000 && h.retryDelayMs(1) < 1500, "first wait is about a second");
  ok(h.retryDelayMs(3) >= 4000, "waits grow");
  ok(h.retryDelayMs(1, 30000) >= 30000, "Retry-After is honoured");
  ok(h.retryDelayMs(1, 999999) <= 61000, "and bounded");
}

// ── JSON repair ───────────────────────────────────────────────────────────
{
  const p = (s, o) => h.parseJsonLoose(s, o);
  eq(p('{"a":1}'), { ok: true, value: { a: 1 }, repair: "none" }, "strict JSON");
  eq(p(""), { ok: true, value: {}, repair: "none" }, "empty arguments are an empty object");
  eq(p('```json\n{"a": 1}\n```').value, { a: 1 }, "a fence is removed");
  eq(p('{"a": 1,}').value, { a: 1 }, "a trailing comma");
  eq(p("{'a': 'b'}").value, { a: "b" }, "single quotes");
  eq(p('{"a": "line one\nline two"}').value, { a: "line one\nline two" }, "a raw newline in a string");
  eq(p('Here you go: {"path": "x.md"} hope that helps').value, { path: "x.md" }, "prose around the object");
  eq(p(JSON.stringify(JSON.stringify({ a: 1 }))).value, { a: 1 }, "encoded twice");
  eq(p("{'a': True, 'b': None}").value, { a: true, b: null }, "python literals");
  eq(p('{"path": "a.md", "content": "hello wor').ok, false, "a cut-off answer is refused by default");
  const t = p('{"path": "a.md", "content": "hello wor', { allowTruncated: true });
  eq([t.ok, t.repair, t.value], [true, "truncated", { path: "a.md", content: "hello wor" }], "…and closed when allowed");
  const t2 = p('{"path": "a.md", "con', { allowTruncated: true });
  eq([t2.ok, t2.value], [true, { path: "a.md" }], "a half-written key is dropped");
  const t3 = p('{"items": [1, 2, {"a": 3', { allowTruncated: true });
  eq(t3.value, { items: [1, 2, { a: 3 }] }, "nested brackets are closed in order");
  eq(h.parseToolArguments("[1,2]").ok, false, "arguments must be an object");
  eq(h.parseToolArguments("not json at all").ok, false, "garbage is refused");
  eq(h.parseToolArguments('{"a":1}').args, { a: 1 }, "arguments come back as an object");
}

// ── tool calls written as text ────────────────────────────────────────────
const tools = ["read_note", "write_note", "search_notes"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
{
  const x = (text) => h.extractTextToolCalls(text, tools);
  let r = x('I will read it.\n<tool_call>\n{"name": "read_note", "arguments": {"path": "A.md"}}\n</tool_call>');
  eq([r.calls.length, r.calls[0].name, JSON.parse(r.calls[0].arguments), r.text], [1, "read_note", { path: "A.md" }, "I will read it."], "Hermes-style tag");
  r = x('<tool_call>{"name": "read_note", "arguments": {"path": "A.md"}}');
  eq(r.calls.length, 1, "an unclosed tag at the end");
  r = x('[TOOL_CALLS] [{"name": "search_notes", "arguments": {"query": "x"}, "id": "abc"}]');
  eq([r.calls[0].name, r.calls[0].id], ["search_notes", "abc"], "Mistral-style list");
  r = x('{"name": "read_note", "parameters": {"path": "B.md"}}');
  eq([r.calls[0].name, JSON.parse(r.calls[0].arguments), r.text], ["read_note", { path: "B.md" }, ""], "a bare object, `parameters` as the key");
  r = x('```json\n{"tool": "write_note", "args": {"path": "C.md", "content": "hi"}}\n```');
  eq(r.calls[0].name, "write_note", "a fenced block");
  r = x('<function=read_note>{"path": "D.md"}</function>');
  eq(JSON.parse(r.calls[0].arguments), { path: "D.md" }, "function tag");
  r = x('{"name": "Read-Note", "arguments": {"path": "E.md"}}');
  eq(r.calls[0].name, "read_note", "a name differing in case and separators");
  r = x('{"name": "delete_everything", "arguments": {}}');
  eq(r.calls.length, 0, "a tool that does not exist is not a call");
  r = x('Here is JSON: {"name": "Alice", "age": 3}');
  eq(r.calls.length, 0, "ordinary JSON is left alone");
  r = x("Just an answer.");
  eq([r.calls.length, r.text], [0, "Just an answer."], "plain text is untouched");
  r = x('<tool_call>{"name":"read_note","arguments":{"path":"a"}}</tool_call>\n```json\n{"name":"read_note","arguments":{"path":"a"}}\n```');
  eq(r.calls.length, 1, "the same call written twice runs once");
  eq(h.matchToolName("functions.read_note", tools), "read_note", "namespaced name");
}
{
  // The guard between the stream and the screen.
  const run = (chunks, enabled = true) => {
    const shown = [];
    const guard = new h.ToolCallTextGuard((c) => shown.push(c), enabled);
    for (const c of chunks) guard.push(c);
    return { guard, shown };
  };
  let r = run(["Hello ", "there, ", "friend."]);
  r.guard.release();
  eq(r.shown.join(""), "Hello there, friend.", "ordinary text passes through");
  r = run(["Let me look. <tool", "_call>{\"name\":\"read_note\",\"arguments\":{}}</tool_call>"]);
  eq(r.shown.join(""), "Let me look. ", "a marker split across chunks is held back");
  ok(r.guard.isHolding, "and held");
  r = run(['{"name":', ' "read_note", "arguments": {}}']);
  eq(r.shown.join(""), "", "a message that opens with { is held whole");
  r.guard.release();
  eq(r.shown.join(""), '{"name": "read_note", "arguments": {}}', "…and released if it was not a call");
  r = run(["a < b and c <"]);
  r.guard.release();
  eq(r.shown.join(""), "a < b and c <", "a harmless < is not held for good");
  r = run(["<tool_call>x"], false);
  eq(r.shown.join(""), "<tool_call>x", "disabled: everything passes");
}

// ── sanitizing ────────────────────────────────────────────────────────────
{
  const call = (id, name = "read_note") => ({ id, name, arguments: "{}" });
  let r = h.sanitizeConversation([
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", content: "ra", tool_call_id: "a" },
    { role: "user", content: "next" },
  ]);
  eq(r.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "tool", "user"], "a call with no result gets one");
  eq([r.messages[4].tool_call_id, r.messages[4].content], ["b", h.INTERRUPTED_RESULT], "…saying it was interrupted");
  eq(r.report.missingResultsAdded, 1, "and the report says so");

  r = h.sanitizeConversation([
    { role: "user", content: "hi" },
    { role: "tool", content: "stray", tool_call_id: "zzz" },
    { role: "assistant", content: "ok" },
  ]);
  eq([r.messages.map((m) => m.role), r.report.orphanResultsDropped], [["user", "assistant"], 1], "a result with no call is dropped");

  r = h.sanitizeConversation([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [call("fc-read_note")] },
    { role: "tool", content: "one", tool_call_id: "fc-read_note" },
    { role: "assistant", content: "", tool_calls: [call("fc-read_note")] },
    { role: "tool", content: "two", tool_call_id: "fc-read_note" },
    { role: "assistant", content: "done" },
  ]);
  const ids = r.messages.filter((m) => m.tool_calls).map((m) => m.tool_calls[0].id);
  ok(ids[0] !== ids[1], "a repeated id is made unique");
  eq(r.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ids, "…and the results follow it");
  eq(r.messages.filter((m) => m.role === "tool").map((m) => m.content), ["one", "two"], "…each to its own call");

  r = h.sanitizeConversation([
    { role: "user", content: "hi" },
    { role: "assistant", content: "  " },
    { role: "user", content: "" },
    { role: "assistant", content: "fine" },
  ]);
  eq(r.messages.map((m) => m.content), ["hi", "fine"], "empty messages are dropped");

  r = h.sanitizeConversation([
    { role: "system", content: "s" },
    { role: "assistant", content: "I was first" },
    { role: "user", content: "hi" },
  ]);
  eq(r.messages.map((m) => m.role), ["system", "user"], "the first turn is the user's");

  r = h.sanitizeConversation([
    { role: "user", content: "[Initial context access: ONLY note \"a.md\".]\n\nfirst question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "[Initial context access: ONLY note \"a.md\".]\n\nsecond question" },
  ], { stripStaleAccessNotes: true });
  eq(r.messages.map((m) => m.content), ["first question", "answer", "[Initial context access: ONLY note \"a.md\".]\n\nsecond question"], "old access notes are removed, the current one kept");
  eq(h.reportIsClean(h.sanitizeConversation([{ role: "user", content: "x" }]).report), true, "a clean history reports clean");
}

// ── tool output ───────────────────────────────────────────────────────────
{
  const long = "x".repeat(300_000);
  const small = h.prepareToolOutput("read_note", long, { contextWindow: 8000, vision: false });
  ok(small.truncated && small.text.length < 6000, "an 8k window gets a short cut of a long note");
  ok(small.text.includes("read_note_section"), "…saying how to ask for a part");
  const big = h.prepareToolOutput("read_note", long, { contextWindow: 1_000_000, vision: false });
  ok(big.text.length <= 150_000 + 400, "even a huge window has a ceiling");
  eq(h.prepareToolOutput("read_note", "short", { contextWindow: 8000, vision: false }).truncated, false, "short output is untouched");
  const img = JSON.stringify({ name: "a.png", mime: "image/png", dataUri: "data:image/png;base64," + "A".repeat(4000) });
  const seen = h.prepareToolOutput("get_note_images", img, { contextWindow: 128000, vision: true });
  eq([seen.images.length, seen.images[0].type, seen.images[0].mimeType, seen.imagesFound], [1, "image", "image/png", 1], "images become parts for a model that can see");
  ok(!seen.text.includes("AAAA") && seen.text.includes("a.png"), "…and are no longer in the text");
  const blind = h.prepareToolOutput("get_note_images", img, { contextWindow: 128000, vision: false });
  eq(blind.images.length, 0, "a model that cannot see gets no parts");
  ok(blind.text.includes("cannot see"), "…and is told why");
  ok(!h.prepareToolOutput("fetch_url", "data:image/png;base64," + "B".repeat(2000), { contextWindow: 128000, vision: false }).text.includes("BBBB"), "a stray data URI is cut");
}

// ── prompt-based tools ────────────────────────────────────────────────────
{
  const add = h.promptToolsAddendum(tools);
  ok(add.includes("<tool_call>") && add.includes("read_note"), "the prompt describes the tools and the format");
  const msgs = h.toPromptMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "Looking.", tool_calls: [{ id: "1", name: "read_note", arguments: '{"path":"a"}' }, { id: "2", name: "search_notes", arguments: '{"query":"q"}' }] },
    { role: "tool", content: "A", tool_call_id: "1", tool_name: "read_note" },
    { role: "tool", content: "B", tool_call_id: "2", tool_name: "search_notes" },
  ]);
  eq(msgs.map((m) => m.role), ["user", "assistant", "user"], "no tool role is left, results are one message");
  ok(msgs[1].content.includes('<tool_call>{"name":"read_note"'), "calls are written out");
  ok(msgs[2].content.includes('<tool_response name="read_note">') && msgs[2].content.includes("B"), "results are wrapped");
  const back = h.extractTextToolCalls(msgs[1].content, tools);
  eq(back.calls.map((c) => c.name), ["read_note", "search_notes"], "what is written out reads back");
}

// ── the context manager ───────────────────────────────────────────────────
{
  const profile = h.resolveModelProfile({ ...base, model: "tiny", override: { contextWindow: 20_000, maxOutput: 2_000 } });
  const settings = { autoCompact: true, threshold: 0.8 };
  const cm = new h.ContextManager();
  const filler = (n) => "word ".repeat(n);
  const turn = (i) => [
    { role: "user", content: `question ${i}` },
    { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, name: "read_note", arguments: JSON.stringify({ path: `n${i}.md` }) }] },
    { role: "tool", content: filler(3000), tool_call_id: `c${i}`, tool_name: "read_note" },
    { role: "assistant", content: `answer ${i}` },
  ];
  const system = { role: "system", content: "You are a helper." };
  let conv = [system, ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5), { role: "user", content: "the latest question" }];
  ok(cm.measure(profile, system.content, [], conv.slice(1)) > 17000, "the conversation does not fit comfortably");
  ok(h.compactionTrigger(profile, settings) <= 16000, "compaction starts before the window is full");

  const calls = [];
  let fit = await cm.fit({ profile, conversation: conv, tools: [], settings });
  ok(fit.actions.length > 0 && fit.after < fit.before, "it compacts");
  eq(fit.actions[0].kind, "clear-tool-results", "old tool output goes first");
  ok(fit.messages.some((m) => m.role === "tool" && m.content.startsWith("[Output cleared")), "it leaves a stub that says what was there");
  ok(fit.messages.some((m) => m.content.includes("n1.md")), "…and which call it was");
  eq(fit.messages[fit.messages.length - 1].content, "the latest question", "the latest message is untouched");
  ok(fit.after <= h.compactionTrigger(profile, settings), "the result is back under the trigger");
  const kept = fit.messages.filter((m) => m.role === "tool" && !m.content.startsWith("[Output cleared"));
  eq(kept.length, 3, "the newest three tool results are kept");

  // When clearing is not enough, the oldest turns are summarized.
  const heavy = [system];
  for (let i = 1; i <= 8; i++) heavy.push({ role: "user", content: `question ${i} ${filler(1000)}` }, { role: "assistant", content: `answer ${i} ${filler(1000)}` });
  heavy.push({ role: "user", content: "the latest question" });
  fit = await cm.fit({
    profile, conversation: heavy, tools: [], settings,
    summarize: async (old, previous) => { calls.push({ old: old.length, previous }); return "THE SUMMARY"; },
  });
  eq(fit.actions.find((a) => a.kind === "summarize")?.count > 0, true, "old turns are summarized");
  eq(calls.length >= 1, true, "the summarizer was asked");
  ok(fit.messages[1].content.includes("THE SUMMARY") && fit.messages[1].role === "user", "the summary stands first");
  eq(fit.messages[fit.messages.length - 1].content, "the latest question", "the latest message is last");
  ok(fit.after < fit.before, "and it is smaller");

  // No summarizer: the oldest turns are dropped, with a note.
  fit = await cm.fit({ profile, conversation: heavy, tools: [], settings });
  ok(fit.actions.some((a) => a.kind === "drop"), "without a summarizer they are dropped");
  ok(fit.messages[1].content.includes("removed"), "and the model is told");

  // A tool result never ends up apart from its call.
  const paired = fit.messages;
  for (let i = 0; i < paired.length; i++) {
    if (paired[i].role === "tool") ok(paired.slice(0, i).some((m) => m.tool_calls?.some((c) => c.id === paired[i].tool_call_id)), "every kept tool result has its call");
  }

  // Disabled: nothing is touched.
  fit = await cm.fit({ profile, conversation: heavy, tools: [], settings: { autoCompact: false, threshold: 0.8 } });
  eq(fit.actions.length, 0, "with compaction off it leaves the conversation alone");
  // Forced: even a small conversation is made smaller.
  fit = await cm.fit({ profile, conversation: [system, ...turn(1), { role: "user", content: "x" }], tools: [], settings, force: true });
  ok(fit.actions.length > 0, "forced compaction acts on a small conversation");

  // Output room.
  eq(h.requestMaxOutput(profile, 1000), 2000, "plenty of room: the model's maximum");
  ok(h.requestMaxOutput(profile, 19000) < 1000, "little room: what is left of the window");
  ok(h.requestMaxOutput(profile, 99999) >= 256, "never below a floor");
  const huge = h.resolveModelProfile({ ...base, providerType: "anthropic", model: "claude-sonnet-4-5" });
  eq(h.requestMaxOutput(huge, 100000), 64000, "a big window leaves the whole maximum");
  ok(h.requestMaxOutput(huge, 180000) < 20000, "a nearly full one does not");
  eq(h.requestMaxOutput(huge, 1000, 4000), 4000, "a manual limit holds");

  // The bar.
  const snap = cm.snapshot({ profile, system: system.content, tools: [], history: conv.slice(1), settings });
  eq([snap.window, snap.source, snap.windowSource], [20000, "estimated", "override"], "a snapshot says what it is");
  ok(snap.fraction > 0.8 && ["high", "full"].includes(snap.level), "…and how full");
  const reported = cm.snapshot({ profile, system: system.content, tools: [], history: conv.slice(1), settings, reported: { usage: { inputTokens: 6000, outputTokens: 200 }, historyLength: conv.length - 1 } });
  eq([reported.source, reported.used], ["reported", 6200], "a reported size is trusted");
  const pending = cm.snapshot({ profile, system: system.content, tools: [], history: conv.slice(1), settings, pendingText: filler(200), reported: { usage: { inputTokens: 6000, outputTokens: 200 }, historyLength: conv.length - 1 } });
  ok(pending.used > 6200 && pending.breakdown.pending > 0, "text being typed adds to it");
  eq(h.levelFor(0.3), "ok", "level ok");
  eq(h.levelFor(0.75), "warn", "level warn");
  eq(h.levelFor(0.9), "high", "level high");
  eq(h.levelFor(0.97), "full", "level full");
}

// ── the log ───────────────────────────────────────────────────────────────
{
  const log = new h.HarnessLog();
  log.add("retry", "waited 2s");
  log.add("compact", "cleared things");
  const p = h.resolveModelProfile({ ...base, model: "gpt-4o" });
  const report = log.report(p, { Provider: "Test" });
  ok(report.includes("gpt-4o") && report.includes("[retry]") && report.includes("Provider: Test"), "the report carries the profile and the events");
  eq(log.summary().retry, 1, "events are counted");
}

console.log(`HARNESS_CORE_OK (${count()} checks)`);
