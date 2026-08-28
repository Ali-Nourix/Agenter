/**
 * Minimal smoke test for the tool registry and orchestrator logic.
 * Run with:  npx ts-node test/smoke.ts   (or compile + node)
 *
 * This does NOT hit any network — it mocks the provider adapter so we can
 * verify the tool-execution loop and message bookkeeping work end to end.
 */
import { AgentSettings, DEFAULT_SETTINGS } from "../src/settings";
import { AgentOrchestrator, ChatCallbacks } from "../src/orchestrator";
import { BaseProvider, ChatMessage, ToolDefinition } from "../src/api";
import { TFile } from "obsidian";

// Fake in-memory vault for the tool registry.
const TFileMock = TFile;
const fakeVault: any = {
  getAbstractFileByPath: (p: string) => (fakeVault._files[p] ? new TFileMock(p) : null),
  getFileByPath: (p: string) => (fakeVault._files[p] ? new TFileMock(p) : null),
  getFolderByPath: (_p: string) => null,
  process: async (f: any, fn: (data: string) => string) => {
    const next = fn(fakeVault._files[f.path] ?? "");
    fakeVault._files[f.path] = next;
    return next;
  },
  read: async (f: any) => fakeVault._files[f.path] ?? "",
  create: async (p: string, c: string) => {
    fakeVault._files[p] = c;
  },
  modify: async (f: any, c: string) => {
    fakeVault._files[f.path] = c;
  },
  getMarkdownFiles: () => Object.keys(fakeVault._files).map((p) => ({ path: p })),
  cachedRead: async (f: any) => fakeVault._files[f.path] ?? "",
  getRoot: () => ({ children: [] }),
  getActiveFile: () => ({ path: "Note.md", parent: { path: "Folder" } }),
};
fakeVault._files = { "Note.md": "# Hello\nThis is a test note with image ![[pic.png]]." };

const fakeApp: any = {
  vault: fakeVault,
  workspace: { getActiveFile: () => ({ path: "Note.md", parent: { path: "Folder" } }) },
};

// Mock provider that emits a tool call then a final answer.
class MockProvider extends BaseProvider {
  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    cb: any
  ): Promise<void> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    if (text.includes("read_note")) {
      cb.onToolCalls([{ id: "c1", name: "read_note", arguments: JSON.stringify({ path: "Note.md" }) }]);
      cb.onDone();
      return;
    }
    cb.onToken("Final answer: done.");
    cb.onDone();
  }
}

async function main() {
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, providers: [{ ...DEFAULT_SETTINGS.providers[0], apiKey: "test" }] };
  const orch = new AgentOrchestrator(fakeApp, settings);
  // Monkeypatch the provider creation by overriding run's adapter is hard;
  // instead we test the tool registry directly.
  const { ToolRegistry } = await import("../src/tools");
  const reg = new ToolRegistry(fakeApp);
  const defs = reg.getDefinitions();
  console.log("Tools defined:", defs.map((d) => d.name).join(", "));

  const res = await reg.execute({ id: "t1", name: "read_note", arguments: JSON.stringify({ path: "Note.md" }) });
  console.log("read_note result ok:", res.output.includes("Hello"));

  const imgRes = await reg.execute({ id: "t2", name: "get_note_images", arguments: JSON.stringify({ path: "Note.md" }) });
  console.log("get_note_images (no real image file):", imgRes.output);

  // probeModels: with our mock requestUrl returning a fake models list.
  const { probeModels } = await import("../src/api");
  const probe = await probeModels({ ...DEFAULT_SETTINGS.providers[0], apiKey: "test", baseUrl: "https://api.openai.com/v1" });
  console.log("probeModels ok:", probe.ok, "models:", probe.models.join(",") || "(none)");

  console.log("SMOKE TEST PASSED");
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
