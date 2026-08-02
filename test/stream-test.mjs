import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
import { build } from "esbuild";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [path.join(root, "src/api.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [electronMockPlugin, 
    {
      name: "mock-obsidian",
      setup(ctx) {
        ctx.onResolve({ filter: /^obsidian$/ }, () => ({
          path: "obsidian",
          namespace: "mock",
        }));
        ctx.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
          contents:
            'export const requestUrl = async () => { throw new Error("unexpected requestUrl fallback"); };',
          loader: "js",
        }));
      },
    },
  ],
});

const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(result.outputFiles[0].text).toString("base64");
const { OpenAIProvider } = await import(moduleUrl);

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":" second"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    }, 120);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Could not start test server.");
}

const provider = new OpenAIProvider({
  id: "stream-test",
  name: "Stream test",
  type: "openai-compatible",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "test",
  model: "test-model",
  extraHeaders: "",
  supportsWebSearch: false,
  supportsVision: false,
});

const started = Date.now();
let firstTokenAt = 0;
let completedAt = 0;
let text = "";

await provider.chat([{ role: "user", content: "hello" }], [], {
  onToken(token) {
    if (!firstTokenAt) firstTokenAt = Date.now();
    text += token;
  },
  onDone() {
    completedAt = Date.now();
  },
  onError(error) {
    throw error;
  },
});

server.close();

const firstDelay = firstTokenAt - started;
const totalDelay = completedAt - started;
if (text !== "first second") {
  throw new Error(`Unexpected streamed text: ${JSON.stringify(text)}`);
}
if (!firstTokenAt || totalDelay - firstDelay < 80) {
  throw new Error(
    `Response was buffered instead of streamed (first=${firstDelay}ms total=${totalDelay}ms).`
  );
}

console.log(`STREAM TEST PASSED (first token ${firstDelay}ms, complete ${totalDelay}ms)`);
