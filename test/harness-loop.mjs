// The whole loop: the orchestrator against a local OpenAI-style server that misbehaves on cue. Each scenario is one
// way a model or a provider goes wrong, and what the harness does about it.
import { createServer } from "http";
import { readFileSync } from "fs";
import { load, eq, ok, count } from "./harness-helpers.mjs";

const { AgentOrchestrator, DEFAULT_SETTINGS, createHarnessServices } = await load("test/harness-loop-entry.ts");

// ── a vault with a few notes ──────────────────────────────────────────────
function fakeApp(notes) {
  const files = new Map(Object.entries(notes));
  const file = (path) => (files.has(path) ? Object.assign(Object.create({ constructor: { name: "TFile" } }), { path, name: path.split("/").pop(), extension: "md", parent: { path: "" } }) : null);
  return {
    vault: {
      getFileByPath: (p) => file(p),
      cachedRead: async (f) => files.get(f.path),
      read: async (f) => files.get(f.path),
      getMarkdownFiles: () => [...files.keys()].map(file),
      process: async (f, fn) => files.set(f.path, fn(files.get(f.path))),
      create: async (p, c) => files.set(p, c),
      adapter: {},
    },
    workspace: { getActiveFile: () => null },
    metadataCache: {},
    fileManager: {},
  };
}

// ── a server whose answers are scripted ───────────────────────────────────
function scripted() {
  const requests = [];
  const queue = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      const handler = queue.shift();
      if (!handler) { res.writeHead(500); return res.end("script exhausted"); }
      handler(res, parsed, req);
    });
  });
  const ready = new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  const sse = (res, events) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  return {
    requests, queue, ready, server,
    say: (text, extra = {}) => (res) => sse(res, [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: extra.finish ?? "stop" }] }, ...(extra.usage ? [{ choices: [], usage: extra.usage }] : [])]),
    call: (calls, extra = {}) => (res) => sse(res, [
      ...(extra.text ? [{ choices: [{ delta: { content: extra.text } }] }] : []),
      ...calls.map((c, i) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id ?? `call_${i + 1}`, function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) } }] } }] })),
      { choices: [{ delta: {}, finish_reason: extra.finish ?? "tool_calls" }] },
    ]),
    fail: (status, message, headers = {}) => (res) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify({ error: { message } })); },
    partialThenDie: (text) => (res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`); setTimeout(() => res.destroy(), 30); },
    hang: (text) => (res, _body, req) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`); req.on("close", () => (queue.closed = true)); },
  };
}

function setup(server, url, notes = { "a.md": "alpha note", "b.md": "beta note" }, overrides = {}) {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const provider = settings.providers.find((p) => p.id === "openai-compatible-default");
  Object.assign(provider, { baseUrl: url, apiKey: "k", model: "test-model", supportsVision: false, ...(overrides.provider ?? {}) });
  settings.activeProviderId = provider.id;
  Object.assign(settings, overrides.settings ?? {});
  const services = createHarnessServices(() => undefined);
  const orchestrator = new AgentOrchestrator(fakeApp(notes), settings, services);
  orchestrator.setAccessScope({ mode: "vault" });
  return { settings, provider, services, orchestrator };
}

async function run(orchestrator, input, parts = []) {
  const events = { text: "", tools: [], results: [], errors: [], notices: [], resets: 0, contexts: [], done: false };
  await orchestrator.run(input, {
    onAssistantToken: (t) => (events.text += t),
    onToolUse: (name, args) => events.tools.push([name, args]),
    onToolResult: (r) => events.results.push(r),
    onError: (e) => events.errors.push(e),
    onDone: () => (events.done = true),
    onNotice: (n) => events.notices.push(n),
    onStreamReset: () => { events.resets++; events.text = ""; },
    onContext: (c) => events.contexts.push(c),
  }, parts);
  return events;
}

const lastUserOf = (req) => req.messages.filter((m) => m.role === "user").at(-1);

// 1. A plain answer, and the usage it reports.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("Hello!", { usage: { prompt_tokens: 900, completion_tokens: 12 } }));
  const { orchestrator, settings } = setup(s.server, url);
  const ev = await run(orchestrator, "hi");
  eq([ev.text, ev.errors, ev.done], ["Hello!", [], true], "a plain answer");
  eq(s.requests[0].max_tokens, 32768, "no cap of ours: the unknown model's default maximum is asked for");
  eq(s.requests[0].stream_options, { include_usage: true }, "usage is asked for");
  const snap = orchestrator.snapshot();
  eq([snap.source, snap.used], ["reported", 912], "the bar then shows what the provider counted");
  eq(orchestrator.messages.map((m) => m.role), ["user", "assistant"], "the conversation is kept");
  ok(ev.contexts.length >= 1, "the bar was told about the window during the run");
  s.server.close();
}

// 2. A tool round trip, with the arguments as the model wrote them.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "read_note", args: { path: "a.md" } }]));
  s.queue.push(s.say("It says alpha."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "read a");
  eq([ev.text, ev.tools.map((t) => t[0]), ev.results], ["It says alpha.", ["read_note"], ["alpha note"]], "the tool runs and the model answers from it");
  const second = s.requests[1].messages;
  eq(second.map((m) => m.role), ["system", "user", "assistant", "tool"], "the second request carries the call and its result");
  eq([second[3].tool_call_id, second[2].tool_calls[0].id], ["call_1", "call_1"], "ids match");
  s.server.close();
}

// 3. An answer cut off by the output limit is continued, and kept as one.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("The first half of the answer, ", { finish: "length" }));
  s.queue.push(s.say("and the second half."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "write a lot");
  eq(ev.text, "The first half of the answer, and the second half.", "the person sees one answer");
  ok(/Continue exactly where you stopped/.test(lastUserOf(s.requests[1]).content), "the model was asked to go on");
  eq(orchestrator.messages.map((m) => m.role), ["user", "assistant"], "the nudge is not kept");
  eq(orchestrator.messages[1].content, "The first half of the answer, and the second half.", "and the pieces are joined in the history");
  ok(ev.notices.some((n) => /output limit/.test(n.text)), "the person was told");
  s.server.close();
}

// 4. A tool call with broken JSON is repaired when it can be, refused when it cannot.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "read_note", args: "{'path': 'a.md',}" }]));
  s.queue.push(s.say("done"));
  const { orchestrator, services } = setup(s.server, url);
  const ev = await run(orchestrator, "read a");
  eq(ev.results, ["alpha note"], "single quotes and a trailing comma: the call runs");
  ok(services.log.all().some((e) => e.kind === "repair"), "and the repair is logged");
  eq(JSON.parse(s.requests[1].messages[2].tool_calls[0].function.arguments), { path: "a.md" }, "the history holds the repaired arguments");
  s.server.close();

  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.call([{ name: "read_note", args: "this is not json" }]));
  t.queue.push(t.call([{ name: "read_note", args: { path: "b.md" } }]));
  t.queue.push(t.say("ok"));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "read b");
  ok(/not valid JSON/.test(ev2.results[0]) && ev2.results[0].startsWith("Tool error:"), "garbage is returned to the model as an error it can act on");
  eq(ev2.results[1], "beta note", "and the corrected call runs");
  t.server.close();

  const u = scripted(); const uurl = await u.ready;
  u.queue.push(u.call([{ name: "read_note", args: {} }]));
  u.queue.push(u.say("sorry"));
  const o3 = setup(u.server, uurl);
  const ev3 = await run(o3.orchestrator, "read");
  ok(/Missing required argument\(s\): path/.test(ev3.results[0]), "a missing required argument is named");
  u.server.close();

  const v = scripted(); const vurl = await v.ready;
  v.queue.push(v.call([{ name: "read_nope", args: {} }]));
  v.queue.push(v.say("sorry"));
  const o4 = setup(v.server, vurl);
  const ev4 = await run(o4.orchestrator, "read");
  ok(/Unknown tool "read_nope"\. The tools are: .*read_note/.test(ev4.results[0]), "an unknown tool lists the real ones");
  v.server.close();

  const w = scripted(); const wurl = await w.ready;
  w.queue.push(w.call([{ name: "Read-Note", args: { path: "a.md" } }]));
  w.queue.push(w.say("fine"));
  const o5 = setup(w.server, wurl);
  const ev5 = await run(o5.orchestrator, "read");
  eq(ev5.results, ["alpha note"], "a tool name off by case and a hyphen is understood");
  w.server.close();
}

// 5. A tool call cut off by the limit is never run half-written.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "write_note", args: '{"path": "n.md", "content": "a very long note that never fini' }], { finish: "length" }));
  s.queue.push(s.say("Understood, the note stays short."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "write", []);
  ok(/cut off and not run/.test(ev.results[0]), "the model is told its call was cut off");
  eq(ev.text, "Understood, the note stays short.", "and it carries on");
  s.server.close();
}

// 6. A tool call written as text is run, and its markup is not shown.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say('I will look.\n<tool_call>{"name": "read_note", "arguments": {"path": "a.md"}}</tool_call>'));
  s.queue.push(s.say("alpha, as I thought."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "read a");
  eq(ev.results, ["alpha note"], "the call written as text ran");
  ok(!/tool_call/.test(ev.text), "its markup never reached the screen");
  ok(ev.text.includes("alpha, as I thought."), "the answer did");
  ok(ev.notices.some((n) => /as text/.test(n.text)), "and the person was told");
  const asked = s.requests[1].messages;
  ok(asked.some((m) => m.role === "assistant" && m.tool_calls?.[0].function.name === "read_note"), "the history holds it as a real call");

  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.say('{"name": "read_note", "arguments": {"path": "b.md"}}'));
  t.queue.push(t.say("beta."));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "read b");
  eq([ev2.results, ev2.text], [["beta note"], "beta."], "a reply that is nothing but the call object runs too");

  const u = scripted(); const uurl = await u.ready;
  u.queue.push(u.say('{"name": "Alice", "age": 3}'));
  const o3 = setup(u.server, uurl);
  const ev3 = await run(o3.orchestrator, "give me json");
  eq([ev3.text, ev3.tools.length], ['{"name": "Alice", "age": 3}', 0], "ordinary JSON is shown, not mistaken for a call");

  const v = scripted(); const vurl = await v.ready;
  v.queue.push(v.say('{"name": "read_note", "arguments": {"path": "b.md"}}'));
  v.queue.push(v.say("plain"));
  const o4 = setup(v.server, vurl, undefined, { settings: { textToolCalls: false } });
  const ev4 = await run(o4.orchestrator, "x");
  eq([ev4.tools.length, ev4.text], [0, '{"name": "read_note", "arguments": {"path": "b.md"}}'], "with the switch off nothing is read from text");
  s.server.close(); t.server.close(); u.server.close(); v.server.close();
}

// 7. Temporary errors are waited out.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.fail(503, "Service Unavailable", { "Retry-After": "0" }));
  s.queue.push(s.fail(429, "Rate limit reached", { "Retry-After": "0" }));
  s.queue.push(s.say("finally"));
  const { orchestrator, services } = setup(s.server, url);
  const started = Date.now();
  const ev = await run(orchestrator, "hi");
  eq([ev.text, ev.errors], ["finally", []], "two refusals, then an answer, and no error shown");
  eq(ev.notices.filter((n) => n.kind === "retry").length, 2, "each wait was announced");
  ok(Date.now() - started >= 1000, "it actually waited");
  eq(services.log.summary().retry, 2, "and logged");
  s.server.close();

  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.partialThenDie("Half an ans"));
  t.queue.push(t.say("A whole answer."));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "hi");
  eq([ev2.text, ev2.errors, ev2.resets], ["A whole answer.", [], 1], "a stream that dies half way is made again, and the half answer is wiped from the screen");
  t.server.close();

  const u = scripted(); const uurl = await u.ready;
  u.queue.push(u.fail(401, "Incorrect API key provided"));
  const o3 = setup(u.server, uurl);
  const ev3 = await run(o3.orchestrator, "hi");
  ok(ev3.errors.length === 1 && /credentials/.test(ev3.errors[0]), "a wrong key is reported at once, in words that help");
  eq(u.requests.length, 1, "and not retried");
  u.server.close();

  const v = scripted(); const vurl = await v.ready;
  v.queue.push(v.fail(503, "down"));
  const o4 = setup(v.server, vurl, undefined, { settings: { retryTransientErrors: false } });
  const ev4 = await run(o4.orchestrator, "hi");
  eq([ev4.errors.length, v.requests.length], [1, 1], "with retries off the first failure is final");
  v.server.close();
}

// 8. What an error says about the request is learned, and the request is made again.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.fail(400, "max_tokens is too large: 32768. This model supports at most 8192 completion tokens, whereas you provided 32768."));
  s.queue.push(s.say("short enough"));
  const { orchestrator, settings } = setup(s.server, url);
  const ev = await run(orchestrator, "hi");
  eq([s.requests[0].max_tokens, s.requests[1].max_tokens, ev.text], [32768, 8192, "short enough"], "the output limit named in the error is used");
  eq(settings.modelLimits["openai-compatible-default:test-model"].maxOutput, 8192, "and remembered for the next time");
  s.server.close();

  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.fail(400, "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported."));
  t.queue.push(t.say("ok"));
  const o2 = setup(t.server, turl);
  await run(o2.orchestrator, "hi");
  eq([t.requests[0].temperature, t.requests[1].temperature, o2.settings.modelLimits["openai-compatible-default:test-model"].acceptsTemperature], [0.7, undefined, false], "a temperature the model refuses is left out");
  t.server.close();

  const u = scripted(); const uurl = await u.ready;
  u.queue.push(u.fail(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."));
  u.queue.push(u.say("ok"));
  const o3 = setup(u.server, uurl);
  await run(o3.orchestrator, "hi");
  eq([u.requests[0].max_tokens !== undefined, u.requests[1].max_completion_tokens !== undefined, u.requests[1].max_tokens], [true, true, undefined], "max_tokens becomes max_completion_tokens");
  u.server.close();

  const v = scripted(); const vurl = await v.ready;
  v.queue.push(v.fail(400, "Unrecognized request argument supplied: stream_options"));
  v.queue.push(v.say("ok"));
  const o4 = setup(v.server, vurl);
  await run(o4.orchestrator, "hi");
  eq([v.requests[0].stream_options !== undefined, v.requests[1].stream_options], [true, undefined], "stream_options is dropped for a server that does not know it");
  v.server.close();
}

// 9. A model that cannot take tools through the API gets them in its prompt.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.fail(400, "registry.ollama.ai/library/gemma3 does not support tools"));
  s.queue.push(s.say('<tool_call>{"name": "read_note", "arguments": {"path": "a.md"}}</tool_call>'));
  s.queue.push(s.say("The note says alpha."));
  const { orchestrator, settings } = setup(s.server, url);
  const ev = await run(orchestrator, "read a");
  eq([s.requests[0].tools !== undefined, s.requests[1].tools], [true, undefined], "tools are no longer sent");
  ok(/<tool_call>/.test(s.requests[1].messages[0].content) && /read_note/.test(s.requests[1].messages[0].content), "they are described in the system prompt");
  eq(ev.results, ["alpha note"], "the call the model wrote runs");
  const third = s.requests[2].messages;
  ok(!third.some((m) => m.role === "tool" || m.tool_calls), "the third request has no tool role");
  ok(third.at(-1).content.includes('<tool_response name="read_note">'), "the result comes back as a user message");
  eq(ev.text, "The note says alpha.", "and the model answers");
  eq(settings.modelLimits["openai-compatible-default:test-model"].nativeTools, false, "it is remembered");
  const again = scripted(); const aurl = await again.ready;
  again.queue.push(again.say("hello"));
  const o2 = setup(again.server, aurl); o2.settings.modelLimits = settings.modelLimits;
  await run(o2.orchestrator, "hi");
  eq(again.requests[0].tools, undefined, "next time it starts that way");
  s.server.close(); again.server.close();
}

// 10. A conversation that outgrows the window is compacted, and the window is learned.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.fail(400, "This model's maximum context length is 20000 tokens. However, your messages resulted in 31000 tokens. Please reduce the length of the messages."));
  // Summary requests (there may be several rounds) and then the real one.
  const smart = (final) => (res, body) => (/^You compress/.test(body.messages[0].content) ? s.say("SUMMARY OF EARLIER TALK")(res) : s.say(final)(res));
  for (let i = 0; i < 6; i++) s.queue.push(smart("answer after compaction"));
  const { orchestrator, settings } = setup(s.server, url);
  const filler = (n) => "lorem ".repeat(n);
  const history = [];
  for (let i = 1; i <= 6; i++) history.push({ role: "user", content: `question ${i} ${filler(900)}` }, { role: "assistant", content: `answer ${i} ${filler(900)}` });
  orchestrator.setMessages(history);
  const ev = await run(orchestrator, "and now?");
  eq(ev.text, "answer after compaction", "after the overflow it answers");
  eq(settings.modelLimits["openai-compatible-default:test-model"].contextWindow, 20000, "the window named in the error is learned");
  ok(ev.notices.some((n) => n.kind === "compact" && /Context compacted/.test(n.text)), "the person is told the context was compacted");
  ok(/You compress/.test(s.requests[1].messages[0].content), "the model was asked to summarize");
  const answered = s.requests.at(-1);
  ok(answered.messages.some((m) => m.role === "user" && /SUMMARY OF EARLIER TALK/.test(m.content)), "the summary replaced the old turns");
  ok(answered.messages.length < 12, "and the request is much smaller");
  eq(answered.messages.at(-1).content, "and now?", "the new question is last");
  const snap = orchestrator.snapshot();
  eq(snap.window, 20000, "the bar shows the learned window");
  s.server.close();
}

// 10b. When only the room for the answer was over-estimated, the answer is shortened; nothing is summarized.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.fail(400, "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again"));
  s.queue.push(s.say("a shorter answer"));
  const { orchestrator } = setup(s.server, url, undefined, { provider: { model: "claude-sonnet-4-5" } });
  const ev = await run(orchestrator, "hi");
  eq(ev.text, "a shorter answer", "it answers");
  eq(s.requests.length, 2, "with no summary request in between");
  ok(s.requests[1].max_tokens < 11800 && s.requests[1].max_tokens >= 512, "the second request asks for what the input left room for");
  ok(ev.notices.some((n) => /limited to/.test(n.text)), "and says so");
  s.server.close();
}

// 11. Compaction before the window is full, not after the error.
{
  const s = scripted(); const url = await s.ready;
  const smart = (res, body) => (/^You compress/.test(body.messages[0].content) ? s.say("SUMMARY")(res) : s.say("fine")(res));
  for (let i = 0; i < 6; i++) s.queue.push(smart);
  const { orchestrator } = setup(s.server, url, undefined, { settings: { modelOverrides: { "openai-compatible-default:test-model": { contextWindow: 16000, maxOutput: 2000 } } } });
  const filler = (n) => "lorem ".repeat(n);
  const history = [];
  for (let i = 1; i <= 5; i++) history.push({ role: "user", content: `q${i} ${filler(900)}` }, { role: "assistant", content: `a${i} ${filler(900)}` });
  orchestrator.setMessages(history);
  const ev = await run(orchestrator, "next");
  eq(ev.errors, [], "no error");
  ok(s.requests.length >= 2 && !s.requests.slice(0, -1).some((r) => !/^You compress/.test(r.messages[0].content)), "summaries, then one answer: the window was never exceeded");
  eq(s.requests.at(-1).messages.at(-1).content, "next", "and the new message is last");
  ok(ev.notices.some((n) => n.kind === "compact"), "compaction was announced");
  ok(s.requests.at(-1).max_tokens <= 2000, "the user's own output limit holds");
  s.server.close();
}

// 12. After a tool, an empty answer is asked for again; with nothing at all, the person is told.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "read_note", args: { path: "a.md" } }]));
  s.queue.push(s.say(""));
  s.queue.push(s.say("Here is what it says: alpha."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "read a");
  eq(ev.text, "Here is what it says: alpha.", "an empty answer after a tool is asked for again");
  ok(/Continue: use the tool results/.test(lastUserOf(s.requests[2]).content), "with a nudge");
  eq(orchestrator.messages.some((m) => m.metadata?.kind === "nudge"), false, "which is not kept");
  s.server.close();

  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.say(""));
  t.queue.push(t.say(""));
  t.queue.push(t.say(""));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "hi");
  ok(/empty answer/.test(ev2.text), "a model that says nothing is not shown as a blank");
  eq(t.requests.length, 3, "after being asked twice to answer");
  ok(/Your last reply was empty/.test(lastUserOf(t.requests[1]).content), "the first ask does not need tool results to make sense");
  t.server.close();
}

// 13. A model that repeats the same call is warned, then asked to answer with what it has.
{
  const s = scripted(); const url = await s.ready;
  for (let i = 0; i < 6; i++) s.queue.push(s.call([{ name: "read_note", args: { path: "a.md" } }]));
  s.queue.push(s.say("All I could find is: alpha note."));
  const { orchestrator, services } = setup(s.server, url);
  const ev = await run(orchestrator, "read a forever");
  ok(ev.results.some((r) => /made 3 times in a row/.test(r)), "the third repeat carries a warning");
  eq(ev.errors, [], "the sixth is not an error");
  eq(s.requests.length, 7, "it gets one more request");
  ok(/Do not call any more tools/.test(lastUserOf(s.requests[6]).content), "in which it is told to answer from what it has");
  eq(ev.text, "All I could find is: alpha note.", "and that is the answer");
  ok(services.log.all().some((e) => e.kind === "loop-guard"), "it is logged");
  s.server.close();

  // And if it still insists, what it writes is used and the calls are not run.
  const t = scripted(); const turl = await t.ready;
  for (let i = 0; i < 6; i++) t.queue.push(t.call([{ name: "read_note", args: { path: "a.md" } }]));
  t.queue.push(t.call([{ name: "read_note", args: { path: "a.md" } }], { text: "I give up; the note says alpha." }));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "read a forever");
  eq([ev2.text, ev2.errors, ev2.tools.length], ["I give up; the note says alpha.", [], 6], "a seventh call is not run, and its text is the answer");
  t.server.close();

  // With the setting off the old behaviour stays: an error.
  const u = scripted(); const uurl = await u.ready;
  for (let i = 0; i < 8; i++) u.queue.push(u.call([{ name: "read_note", args: { path: "a.md" } }]));
  const o3 = setup(u.server, uurl, undefined, { settings: { autoContinue: false } });
  const ev3 = await run(o3.orchestrator, "read a forever");
  ok(ev3.errors.some((e) => /same tool call/.test(e)), "with going on by itself off, the sixth stops the run");
  u.server.close();
}

// 14. Output of a tool is cut to the window, and images go to a model that can see.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "read_note", args: { path: "big.md" } }]));
  s.queue.push(s.say("long note"));
  const { orchestrator } = setup(s.server, url, { "big.md": "x".repeat(900_000) }, { settings: { modelOverrides: { "openai-compatible-default:test-model": { contextWindow: 16000 } } } });
  const ev = await run(orchestrator, "read big");
  const tool = s.requests[1].messages.find((m) => m.role === "tool");
  ok(tool.content.length < 12_000 && /omitted from the middle/.test(tool.content), "a huge note is cut to a share of a small window");
  ok(ev.results[0].length < 12_000, "and the screen is shown the same");
  s.server.close();

  const t = scripted(); const turl = await t.ready;
  const png = "data:image/png;base64," + "A".repeat(6000);
  t.queue.push(t.call([{ name: "get_note_images", args: { path: "img.md" } }]));
  t.queue.push(t.say("a cat"));
  const o2 = setup(t.server, turl, { "img.md": "![[x.png]]" }, { provider: { supportsVision: true } });
  // The tool is stubbed: the fake vault has no binary files.
  o2.orchestrator.toolRegistry.dispatch = async () => JSON.stringify({ name: "x.png", mime: "image/png", dataUri: png });
  const ev2 = await run(o2.orchestrator, "what is in the image of img");
  const second = t.requests[1].messages;
  const toolMsg = second.find((m) => m.role === "tool");
  ok(!toolMsg.content.includes("AAAA") && toolMsg.content.includes("x.png"), "the picture is not in the text of the tool result");
  const imageTurn = second.at(-1);
  eq([imageTurn.role, Array.isArray(imageTurn.content), imageTurn.content?.some((c) => c.type === "image_url")], ["user", true, true], "it follows as an image part");
  eq(ev2.text, "a cat", "and the model answers");
  t.server.close();

  const u = scripted(); const uurl = await u.ready;
  u.queue.push(u.call([{ name: "read_note", args: { path: "img.md" } }]));
  u.queue.push(u.say("cannot tell"));
  const o3 = setup(u.server, uurl, { "img.md": "![[x.png]]" }, { provider: { supportsVision: false } });
  // get_note_images is not offered to a model that cannot see; a note read that returns an image shows the same path.
  o3.orchestrator.toolRegistry.dispatch = async () => JSON.stringify({ name: "x.png", mime: "image/png", dataUri: png });
  await run(o3.orchestrator, "image");
  const msgs = u.requests[1].messages;
  ok(msgs.find((m) => m.role === "tool").content.includes("cannot see"), "a model that cannot see is told the picture is there and why it is not shown");
  eq(msgs.some((m) => Array.isArray(m.content)), false, "and receives no image part");
  u.server.close();
}

// 15. A damaged history does not stop a conversation.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("recovered"));
  const { orchestrator, services } = setup(s.server, url);
  orchestrator.setMessages([
    { role: "assistant", content: "I start the history, oddly" },
    { role: "user", content: "[Initial context access: ONLY note \"a.md\".]\n\nearlier" },
    { role: "assistant", content: "", tool_calls: [{ id: "x", name: "read_note", arguments: '{"path":"a.md"}' }] },
    { role: "tool", content: "stray result", tool_call_id: "never-called" },
    { role: "user", content: "[Initial context access: ONLY note \"a.md\".]\n\nlater" },
  ]);
  const ev = await run(orchestrator, "go on");
  eq([ev.text, ev.errors], ["recovered", []], "it answers");
  const sent = s.requests[0].messages;
  eq(sent.map((m) => m.role), ["system", "user", "assistant", "tool", "user", "user"], "the history sent is valid: a result for every call, none without one, and a user turn first");
  ok(!sent[1].content.startsWith("[Initial context access"), "old access notes are gone");
  ok(services.log.all().some((e) => e.kind === "sanitize"), "what was fixed is logged");
  s.server.close();
}

// 16. Stop really stops: the connection is closed and what was done is kept.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.hang("working on it"));
  const { orchestrator } = setup(s.server, url);
  let stop = false;
  orchestrator.shouldAbort = () => stop;
  const running = run(orchestrator, "long task");
  await new Promise((r) => setTimeout(r, 300));
  stop = true;
  const ev = await running;
  eq([ev.done, ev.errors], [true, []], "stopping is not an error");
  await new Promise((r) => setTimeout(r, 150));
  eq(!!s.queue.closed, true, "the request to the provider was closed");
  eq(orchestrator.messages.map((m) => m.role), ["user"], "the question is kept");
  s.server.close();
}

// 17. The answer length limit.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("short"));
  const { orchestrator } = setup(s.server, url, undefined, { settings: { maxTokens: 500 } });
  await run(orchestrator, "hi");
  eq(s.requests[0].max_tokens, 500, "a limit the person sets is honoured");
  s.server.close();
  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.say("short"));
  const o2 = setup(t.server, turl, undefined, { settings: { maxTokens: 0, modelOptions: { "openai-compatible-default:test-model": { max_tokens: 700 } } } });
  await run(o2.orchestrator, "hi");
  eq(t.requests[0].max_tokens, 700, "so is one set for the model alone");
  t.server.close();
  const u = scripted(); const uurl = await u.ready;
  u.queue.push(u.say("fine"));
  const o3 = setup(u.server, uurl, undefined, { provider: { model: "claude-sonnet-4-5" }, settings: {} });
  await run(o3.orchestrator, "hi");
  eq(u.requests[0].max_tokens, 64000, "left alone, a model that is known writes as much as it can");
  u.server.close();
}

// 18. A model that stops after announcing the next step is told to go on.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("I'll deliver it in parts so nothing is lost. First I will write the opening sections."));
  s.queue.push(s.say("Opening: the report begins with the 2025 results and the plan for the year ahead, in full detail."));
  const { orchestrator, services } = setup(s.server, url);
  const ev = await run(orchestrator, "give me the complete text");
  eq(s.requests.length, 2, "a second request is made without anyone typing");
  ok(/Do it now, in this reply/.test(lastUserOf(s.requests[1]).content), "it says to do what was announced");
  ok(ev.text.startsWith("I'll deliver it in parts") && ev.text.includes("\n\nOpening: the report"), "and the screen reads as one answer, the two pieces apart");
  ok(ev.notices.some((n) => n.kind === "info" && /Going on by itself/.test(n.text)), "the person is told");
  eq(orchestrator.messages.map((m) => m.role), ["user", "assistant"], "the history keeps one answer, without the nudge");
  ok(orchestrator.messages[1].content.includes("Opening: the report"), "…with both pieces in it");
  ok(services.log.all().some((e) => e.kind === "keep-going"), "it is logged");
  s.server.close();

  // Asked for permission to go on: yes. And it stops when the model has nothing more to add.
  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.say("Section one is above.\n\nShall I continue with section two?"));
  t.queue.push(t.say("Section two, written out in full with every detail that was asked for, and a short summary after it."));
  t.queue.push(t.say("Everything is written."));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "write the sections");
  ok(/Yes, go on/.test(lastUserOf(t.requests[1]).content), "a question whether to go on is answered");
  eq(t.requests.length, 2, "an answer that is complete is the end");
  t.server.close();

  // A model that keeps asking is not followed forever.
  const u = scripted(); const uurl = await u.ready;
  for (let i = 0; i < 8; i++) u.queue.push(u.say(`Part ${i + 1} is written here with enough text to count as a piece of work.\n\nShall I continue?`));
  const o3 = setup(u.server, uurl);
  const ev3 = await run(o3.orchestrator, "go");
  eq(u.requests.length, 5, "after four nudges it is left to ask");
  eq(ev3.errors, [], "without an error");
  u.server.close();

  // A continuation that adds almost nothing ends it.
  const v = scripted(); const vurl = await v.ready;
  v.queue.push(v.say("It is all there. Shall I continue?"));
  v.queue.push(v.say("Nothing more. Shall I continue?"));
  const o4 = setup(v.server, vurl);
  await run(o4.orchestrator, "go");
  eq(v.requests.length, 2, "a reply that adds almost nothing is not asked again");
  v.server.close();

  // Off: it waits to be told.
  const w = scripted(); const wurl = await w.ready;
  w.queue.push(w.say("Section one is above.\n\nShall I continue with section two?"));
  const o5 = setup(w.server, wurl, undefined, { settings: { autoContinue: false } });
  await run(o5.orchestrator, "write the sections");
  eq(w.requests.length, 1, "with the setting off, nothing is added");
  w.server.close();

  // Mid-work: after tools, a bare announcement is the model stopping.
  const x = scripted(); const xurl = await x.ready;
  x.queue.push(x.call([{ name: "read_note", args: { path: "a.md" } }]));
  x.queue.push(x.say("I have read it. Next I will summarize b.md."));
  x.queue.push(x.call([{ name: "read_note", args: { path: "b.md" } }]));
  x.queue.push(x.say("Both notes are covered: alpha and beta."));
  const o6 = setup(x.server, xurl);
  const ev6 = await run(o6.orchestrator, "summarize both notes");
  eq([ev6.tools.map((t) => t[0]), x.requests.length], [["read_note", "read_note"], 4], "it goes on to the work it announced");
  x.server.close();
}

// 19. A stop that used the whole output limit was cut off, whatever the provider called it.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("The report finds that revenue grew in the second half of the year", { usage: { prompt_tokens: 500, completion_tokens: 32768 } }));
  s.queue.push(s.say(", mostly from the new product."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "summarize");
  eq(s.requests.length, 2, "a stop at the very limit is continued");
  ok(/Continue exactly where you stopped/.test(lastUserOf(s.requests[1]).content), "from where it stopped");
  eq(orchestrator.messages.at(-1).content, "The report finds that revenue grew in the second half of the year, mostly from the new product.", "and joined without a seam");
  s.server.close();
}

// 20. A connection that drops in the middle of an answer does not lose the answer.
{
  const s = scripted(); const url = await s.ready;
  const first = "Chapter one: the early years were spent in the north, where the family kept sheep and grew barley";
  s.queue.push(s.partialThenDie(first));
  s.queue.push(s.say(" and rye until the winter of 1912."));
  const { orchestrator, services } = setup(s.server, url);
  const ev = await run(orchestrator, "tell me the story");
  eq(ev.resets, 0, "what had arrived stays on the screen");
  eq(s.requests.length, 2, "one more request");
  const again = s.requests[1].messages;
  eq(again.at(-2), { role: "assistant", content: first }, "which carries the partial answer");
  ok(/Continue exactly where you stopped/.test(again.at(-1).content), "and asks the model to go on from it");
  eq(ev.text, first + " and rye until the winter of 1912.", "the screen reads as one answer");
  eq(orchestrator.messages.at(-1).content, first + " and rye until the winter of 1912.", "so does the history");
  ok(ev.notices.some((n) => n.kind === "retry" && /kept/.test(n.text)), "the person is told it was kept");
  s.server.close();

  // Too little to keep: the old behaviour, a fresh request.
  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.partialThenDie("Chapter"));
  t.queue.push(t.say("Chapter one, all of it."));
  const o2 = setup(t.server, turl);
  const ev2 = await run(o2.orchestrator, "story");
  eq([ev2.resets, ev2.text], [1, "Chapter one, all of it."], "a few words are not worth keeping");
  t.server.close();
}

// 21. A model that spent its whole output thinking is asked to think less.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.say("", { finish: "length" }));
  s.queue.push(s.say("The answer is 42."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "what is the answer");
  ok(/Think much more briefly/.test(lastUserOf(s.requests[1]).content), "it is asked to think less");
  eq(ev.text, "The answer is 42.", "and answers");
  eq(orchestrator.messages.some((m) => m.metadata?.kind === "nudge"), false, "the nudge is not kept");
  s.server.close();
}

// 22. After a failure that is about the connection, the work can be picked up again.
{
  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "read_note", args: { path: "a.md" } }]));
  s.queue.push(s.fail(503, "Service Unavailable"));
  const { orchestrator } = setup(s.server, url, undefined, { settings: { retryTransientErrors: false } });
  const infos = [];
  const events = { text: "", errors: [], tools: [] };
  const callbacks = () => ({
    onAssistantToken: (t) => (events.text += t), onToolUse: (n) => events.tools.push(n), onToolResult: () => {},
    onError: (e, info) => { events.errors.push(e); infos.push(info); }, onDone: () => {},
  });
  await orchestrator.run("read a and tell me", callbacks());
  eq(infos, [{ resumable: true }], "a server error is reported as one the work can resume from");
  s.queue.push(s.say("The note says alpha."));
  await orchestrator.resume(callbacks());
  const last = s.requests.at(-1).messages;
  ok(/Carry on from where you were interrupted/.test(last.at(-1).content), "resuming tells the model to carry on");
  eq(last.filter((m) => m.role === "tool").length, 1, "with the work already done still in the history");
  eq(events.text, "The note says alpha.", "and it finishes");
  s.server.close();

  // An error that resuming cannot mend is not offered it.
  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.fail(401, "Incorrect API key provided"));
  const o2 = setup(t.server, turl);
  const infos2 = [];
  await o2.orchestrator.run("hi", { onAssistantToken() {}, onToolUse() {}, onToolResult() {}, onError: (e, info) => infos2.push(info), onDone() {} });
  eq(infos2, [{ resumable: false }], "a refused key is not");
  t.server.close();
}

// 23. A PDF is read so that a model can understand it: laid out, in pieces, and on request.
{
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/pdf-items.json", import.meta.url), "utf8"));
  const pages = [fixtures.persian1, fixtures.persian2];
  globalThis.__pdfjs = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getMetadata: async () => ({ info: {} }),
        getPage: async (n) => ({ getTextContent: async () => ({ items: pages[n - 1] }), getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }) }),
        destroy() {},
      }),
    }),
  };
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n%%EOF");
  const part = { type: "pdf", data: pdf.toString("base64"), mimeType: "application/pdf", name: "گزارش.pdf" };

  const s = scripted(); const url = await s.ready;
  s.queue.push(s.call([{ name: "read_pdf", args: { query: "پیوست" } }]));
  s.queue.push(s.call([{ name: "read_pdf", args: { pages: "2" } }]));
  s.queue.push(s.say("The appendix lists the results."));
  const { orchestrator } = setup(s.server, url);
  const ev = await run(orchestrator, "what does it say?", [part]);
  const first = lastUserOf(s.requests[0]).content;
  ok(first.includes("گزارش فصلی") && first.includes("برنامهٔ سال آینده"), "the model gets the text of a Persian PDF as Persian");
  ok(!/[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(first), "not as presentation-form glyphs");
  ok(first.includes("[Page 1]") && first.includes("[Page 2]"), "page by page");
  ok(s.requests[0].tools.some((t) => t.function.name === "read_pdf"), "and the tool to read more of it is offered");
  ok(/Page 2: .*پیوست/.test(ev.results[0]), "a search finds the page, by Persian letters");
  ok(ev.results[1].includes("[Page 2]") && ev.results[1].includes("Acme"), "a page can be read by number later, from the copy kept in memory");
  eq(ev.text, "The appendix lists the results.", "and the model answers from it");
  s.server.close();

  // A big one is cut to the window and says how to get the rest.
  const lorem = (n) => Array.from({ length: 800 }, (_, i) => ({ str: `w${n}x${i}`, transform: [10, 0, 0, 10, 20 + (i % 20) * 24, 700 - Math.floor(i / 20) * 12], width: 20, height: 10, dir: "ltr", hasEOL: false }));
  const many = Array.from({ length: 30 }, (_, i) => lorem(i + 1));
  globalThis.__pdfjs = { getDocument: () => ({ promise: Promise.resolve({ numPages: many.length, getMetadata: async () => ({ info: {} }), getPage: async (n) => ({ getTextContent: async () => ({ items: many[n - 1] }) }), destroy() {} }) }) };
  const t = scripted(); const turl = await t.ready;
  t.queue.push(t.say("ok"));
  const o2 = setup(t.server, turl, undefined, { settings: { modelOverrides: { "openai-compatible-default:test-model": { contextWindow: 12000 } } } });
  await run(o2.orchestrator, "summarize", [{ ...part, name: "big.pdf" }]);
  const big = lastUserOf(t.requests[0]).content;
  ok(big.length < 14_000, "a PDF too big for the window is cut to a share of it");
  ok(/Pages \d+-30 are not included here: read them with the read_pdf tool \(attachment "big\.pdf"/.test(big), "and the model is told which pages are missing and how to ask for them");
  t.server.close();
  delete globalThis.__pdfjs;
}

console.log(`HARNESS_LOOP_OK (${count()} checks)`);
