import { App, TFile, TFolder, Notice, requestUrl } from "obsidian";
import { ToolDefinition, ToolCall } from "./api";

export interface ToolResult {
  callId: string;
  output: string;
}

/**
 * Registry of tools the agent can use. Each tool maps to an Obsidian
 * vault operation. Vision is provided by reading embedded/linked image
 * files as base64 data URIs and passing them to a vision-capable model.
 */
export class ToolRegistry {
  constructor(private app: App) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: "read_note",
        description:
          "Read the full content of a note by its path (relative to vault root, e.g. 'Folder/Note.md'). Returns markdown content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path inside the vault" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_note",
        description:
          "Create a new note or fully overwrite an existing note with the given markdown content. Use with care — overwrites existing content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path to create/overwrite" },
            content: { type: "string", description: "Markdown content" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_note",
        description:
          "Edit an existing note by replacing an exact old string with a new string. Returns a confirmation or an error if the old string is not found (or not unique).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" },
            old_string: { type: "string", description: "Exact text to replace" },
            new_string: { type: "string", description: "Replacement text" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
      {
        name: "append_note",
        description: "Append markdown content to the end of an existing note.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" },
            content: { type: "string", description: "Content to append" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "search_notes",
        description:
          "Full-text search across the vault. Returns a list of matching notes with a short snippet.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_notes",
        description:
          "List notes in a folder (or the whole vault). Returns paths. Use scope='vault' for everything.",
        parameters: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Folder path, or empty string / 'vault' for the whole vault",
            },
            limit: { type: "number", description: "Max results (default 50)" },
          },
          required: [],
        },
      },
      {
        name: "summarize_note",
        description: "Return a concise summary of a note's content (first portion if very long).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" },
          },
          required: ["path"],
        },
      },
      {
        name: "get_note_images",
        description:
          "Return embedded and linked image files in a note as base64 data URIs so the model can see them (vision). Returns a list of {name, mime, dataUri}.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" },
          },
          required: ["path"],
        },
      },
      {
        name: "web_search",
        description:
          "Search the web for current information. Returns concise search-result titles, URLs, and snippets when available. Provide a precise query.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Web search query" },
          },
          required: ["query"],
        },
      },
      {
        name: "current_note",
        description:
          "Get the path and content of the note currently open in the active editor. Use this to refer to 'this note'.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "list_plugins",
        description:
          "List installed Obsidian plugins and whether each plugin is enabled. Use when the user asks what plugins are installed or wants plugin-aware help.",
        parameters: {
          type: "object",
          properties: {
            includeDisabled: {
              type: "boolean",
              description: "Include disabled plugins too (default true).",
            },
          },
          required: [],
        },
      },
      {
        name: "plugin_info",
        description:
          "Get detailed manifest information for an installed Obsidian plugin by id or name.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Plugin id or display name" },
          },
          required: ["query"],
        },
      },
      {
        name: "fetch_url",
        description:
          "Fetch a public URL and return readable text (truncated). Use for web pages or raw text files when the user provides a URL.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP/HTTPS URL to fetch" },
          },
          required: ["url"],
        },
      },
      {
        name: "find_images",
        description:
          "Find image files in the vault by folder/name. Returns paths and sizes so the assistant can decide which image to inspect with get_note_images or read as context.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder path, or empty/vault for all vault images" },
            query: { type: "string", description: "Optional filename/path substring filter" },
            limit: { type: "number", description: "Max results (default 30)" },
          },
          required: [],
        },
      },
      {
        name: "read_note_section",
        description:
          "Read one heading section from a markdown note. More efficient than reading the whole note.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path inside the vault" },
            heading: { type: "string", description: "Heading text, without # characters" },
          },
          required: ["path", "heading"],
        },
      },
      {
        name: "note_metadata",
        description:
          "Get safe metadata for a note: path, size, created/modified times, frontmatter, headings, and tags.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Note path inside the vault" } },
          required: ["path"],
        },
      },
      {
        name: "note_links",
        description:
          "Get outgoing links, embeds, and backlinks for a note using Obsidian's metadata cache.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Note path inside the vault" } },
          required: ["path"],
        },
      },
      {
        name: "list_folders",
        description: "List folders inside the vault, optionally below one folder.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder path, or empty/vault for the whole vault" },
            limit: { type: "number", description: "Max results (default 100)" },
          },
          required: [],
        },
      },
      {
        name: "create_folder",
        description: "Create a folder inside the Obsidian vault. Requires user approval.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Folder path inside the vault" } },
          required: ["path"],
        },
      },
      {
        name: "move_note",
        description:
          "Move or rename a markdown note inside the vault. Creates a safety backup and requires user approval.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Current note path" },
            destination: { type: "string", description: "New path inside the vault" },
          },
          required: ["path", "destination"],
        },
      },
      {
        name: "trash_note",
        description:
          "Move a markdown note to Obsidian Trash (never permanently delete it). Always creates a safety backup and requires a two-step user confirmation.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Note path inside the vault" } },
          required: ["path"],
        },
      },
    ];
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      const args = JSON.parse(call.arguments || "{}");
      const out = await this.dispatch(call.name, args);
      return { callId: call.id, output: out };
    } catch (e: any) {
      return { callId: call.id, output: `Tool error: ${e.message ?? String(e)}` };
    }
  }

  private async dispatch(name: string, args: any): Promise<string> {
    switch (name) {
      case "read_note":
        return this.readNote(args.path);
      case "write_note":
        return this.writeNote(args.path, args.content);
      case "edit_note":
        return this.editNote(args.path, args.old_string, args.new_string);
      case "append_note":
        return this.appendNote(args.path, args.content);
      case "search_notes":
        return this.searchNotes(args.query, args.limit ?? 10);
      case "list_notes":
        return this.listNotes(args.folder, args.limit ?? 50);
      case "summarize_note":
        return this.summarizeNote(args.path);
      case "get_note_images":
        return this.getNoteImages(args.path);
      case "web_search":
        return this.webSearch(args.query);
      case "current_note":
        return this.currentNote();
      case "list_plugins":
        return this.listPlugins(args.includeDisabled ?? true);
      case "plugin_info":
        return this.pluginInfo(args.query);
      case "fetch_url":
        return this.fetchUrl(args.url);
      case "find_images":
        return this.findImages(args.folder, args.query, args.limit ?? 30);
      case "read_note_section":
        return this.readNoteSection(args.path, args.heading);
      case "note_metadata":
        return this.noteMetadata(args.path);
      case "note_links":
        return this.noteLinks(args.path);
      case "list_folders":
        return this.listFolders(args.folder, args.limit ?? 100);
      case "create_folder":
        return this.createFolder(args.path);
      case "move_note":
        return this.moveNote(args.path, args.destination);
      case "trash_note":
        return this.trashNote(args.path);
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async readNote(path: string): Promise<string> {
    const p = safeVaultPath(path);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof TFile) || file.extension !== "md") return `Note not found: ${p}`;
    return await this.app.vault.read(file);
  }

  private async writeNote(path: string, content: string): Promise<string> {
    const p = safeVaultPath(path, true);
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      const backup = await createSafetyBackup(this.app, existing, "overwrite");
      await this.app.vault.modify(existing, String(content ?? ""));
      return `Overwrote ${p}\nSafety backup: ${backup}`;
    }
    await ensureParentFolder(this.app, p);
    await this.app.vault.create(p, String(content ?? ""));
    return `Created ${p}`;
  }

  private async editNote(path: string, oldS: string, newS: string): Promise<string> {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof TFile)) return `Note not found: ${p}`;
    const content = await this.app.vault.read(file);
    if (!String(oldS ?? "")) return "old_string cannot be empty.";
    const count = content.split(oldS).length - 1;
    if (count === 0) return `old_string not found in ${p}`;
    if (count > 1) return `old_string is not unique in ${p} (found ${count} matches)`;
    const backup = await createSafetyBackup(this.app, file, "edit");
    await this.app.vault.modify(file, content.replace(oldS, String(newS ?? "")));
    return `Edited ${p}\nSafety backup: ${backup}`;
  }

  private async appendNote(path: string, content: string): Promise<string> {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof TFile)) return `Note not found: ${p}`;
    const existing = await this.app.vault.read(file);
    const backup = await createSafetyBackup(this.app, file, "append");
    await this.app.vault.modify(file, existing + "\n" + String(content ?? ""));
    return `Appended to ${p}\nSafety backup: ${backup}`;
  }

  private async searchNotes(query: string, limit: number): Promise<string> {
    const files = this.app.vault.getMarkdownFiles();
    const q = query.toLowerCase();
    const results: string[] = [];
    for (const f of files) {
      const content = await this.app.vault.cachedRead(f);
      if (content.toLowerCase().includes(q)) {
        const idx = content.toLowerCase().indexOf(q);
        const snippet = content.slice(Math.max(0, idx - 60), idx + 120).replace(/\n/g, " ");
        results.push(`- ${f.path}: …${snippet}…`);
        if (results.length >= limit) break;
      }
    }
    return results.length ? results.join("\n") : "No matching notes found.";
  }

  private async listNotes(folder: string, limit: number): Promise<string> {
    const root = this.app.vault.getRoot();
    let base = root;
    if (folder && folder !== "vault") {
      const f = this.app.vault.getAbstractFileByPath(safeVaultPath(folder));
      if (f instanceof TFolder) base = f;
      else return `Folder not found: ${folder}`;
    }
    const out: string[] = [];
    VaultWalker(base, (file) => {
      if (file instanceof TFile && out.length < limit) out.push(file.path);
    });
    return out.length ? out.join("\n") : "No notes found.";
  }

  private async summarizeNote(path: string): Promise<string> {
    const content = await this.readNote(path);
    const head = content.length > 4000 ? content.slice(0, 4000) + "\n…(truncated)" : content;
    return `Content of ${path} (${content.length} chars):\n\n${head}`;
  }

  private async getNoteImages(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(safeVaultPath(path));
    if (!file || !(file instanceof TFile)) return `Note not found: ${path}`;
    const content = await this.app.vault.read(file);
    // Find image links: ![[img.png]] and ![alt](img.png)
    const emb: string[] = [];
    let embMatch: RegExpExecArray | null;
    const embRe = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|webp|bmp))\]\]/gi;
    while ((embMatch = embRe.exec(content)) !== null) emb.push(embMatch[1]);
    const md: string[] = [];
    let mdMatch: RegExpExecArray | null;
    const mdRe = /!\[[^\]]*\]\(([^)]+\.(png|jpg|jpeg|gif|webp|bmp))\)/gi;
    while ((mdMatch = mdRe.exec(content)) !== null) md.push(mdMatch[1]);
    const names = Array.from(new Set([...emb, ...md]));
    const out: string[] = [];
    for (const name of names) {
      const imgPath = safeVaultPath(resolveSibling(file, name));
      const imgFile = this.app.vault.getAbstractFileByPath(imgPath);
      if (imgFile instanceof TFile) {
        const buf = await this.app.vault.readBinary(imgFile);
        const mime = mimeFromName(name);
        const b64 = arrayBufferToBase64(buf);
        out.push(
          JSON.stringify({ name, mime, dataUri: `data:${mime};base64,${b64}` })
        );
      }
    }
    return out.length ? out.join("\n") : "No images found in this note.";
  }

  private async currentNote(): Promise<string> {
    const active = this.app.workspace.getActiveFile();
    if (!active) return "No note currently open.";
    const content = await this.app.vault.read(active);
    return `Current note path: ${active.path}\n\n${content}`;
  }

  private async readNoteSection(path: string, heading: string): Promise<string> {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof TFile)) return `Note not found: ${p}`;
    const content = await this.app.vault.read(file);
    const wanted = String(heading ?? "").replace(/^#+\s*/, "").trim().toLowerCase();
    if (!wanted) return "Heading is required.";
    const lines = content.split("\n");
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
      if (m && m[2].replace(/\s+#+$/, "").trim().toLowerCase() === wanted) {
        start = i; level = m[1].length; break;
      }
    }
    if (start < 0) return `Heading not found in ${p}: ${heading}`;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{1,6})\s+/.exec(lines[i]);
      if (m && m[1].length <= level) { end = i; break; }
    }
    return lines.slice(start, end).join("\n");
  }

  private noteMetadata(path: string): string {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof TFile)) return `Note not found: ${p}`;
    const cache: any = this.app.metadataCache.getFileCache(file) ?? {};
    const tags = Array.from(new Set([
      ...(cache.tags ?? []).map((t: any) => t.tag),
      ...frontmatterTags(cache.frontmatter?.tags),
    ]));
    return JSON.stringify({
      path: file.path,
      basename: file.basename,
      size: file.stat.size,
      created: new Date(file.stat.ctime).toISOString(),
      modified: new Date(file.stat.mtime).toISOString(),
      frontmatter: cache.frontmatter ?? {},
      headings: (cache.headings ?? []).map((h: any) => ({ heading: h.heading, level: h.level })),
      tags,
    }, null, 2);
  }

  private noteLinks(path: string): string {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof TFile)) return `Note not found: ${p}`;
    const cache: any = this.app.metadataCache.getFileCache(file) ?? {};
    const outgoing = (cache.links ?? []).map((l: any) => l.link);
    const embeds = (cache.embeds ?? []).map((l: any) => l.link);
    const backlinks: string[] = [];
    const resolved: any = (this.app.metadataCache as any).resolvedLinks ?? {};
    for (const source of Object.keys(resolved)) {
      if (resolved[source]?.[file.path]) backlinks.push(source);
    }
    return JSON.stringify({ path: file.path, outgoing, embeds, backlinks }, null, 2);
  }

  private listFolders(folder: string, limit: number): string {
    let base: TFolder = this.app.vault.getRoot();
    if (folder && folder !== "vault") {
      const p = safeVaultPath(folder);
      const found = this.app.vault.getAbstractFileByPath(p);
      if (!(found instanceof TFolder)) return `Folder not found: ${p}`;
      base = found;
    }
    const out: string[] = [];
    const walk = (node: TFolder) => {
      for (const child of node.children) {
        if (out.length >= clampLimit(limit, 500)) return;
        if (child instanceof TFolder) { out.push(child.path); walk(child); }
      }
    };
    walk(base);
    return out.length ? out.join("\n") : "No folders found.";
  }

  private async createFolder(path: string): Promise<string> {
    const p = safeVaultPath(path);
    if (this.app.vault.getAbstractFileByPath(p)) return `Path already exists: ${p}`;
    await ensureFolder(this.app, p);
    return `Created folder ${p}`;
  }

  private async moveNote(path: string, destination: string): Promise<string> {
    const from = safeVaultPath(path, true);
    const to = safeVaultPath(destination, true);
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) return `Note not found: ${from}`;
    if (this.app.vault.getAbstractFileByPath(to)) return `Destination already exists: ${to}`;
    const backup = await createSafetyBackup(this.app, file, "move");
    await ensureParentFolder(this.app, to);
    await this.app.fileManager.renameFile(file, to);
    return `Moved ${from} to ${to}\nSafety backup: ${backup}`;
  }

  private async trashNote(path: string): Promise<string> {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof TFile)) return `Note not found: ${p}`;
    const backup = await createSafetyBackup(this.app, file, "trash");
    await this.app.fileManager.trashFile(file);
    return `Moved ${p} to Obsidian Trash (recoverable).\nSafety backup: ${backup}`;
  }

  private async webSearch(query: string): Promise<string> {
    const q = String(query ?? "").trim();
    if (!q) return "Search query is required.";
    const lines: string[] = [];

    // 1) DuckDuckGo Instant Answer API (no API key required).
    try {
      const url =
        "https://api.duckduckgo.com/?q=" +
        encodeURIComponent(q) +
        "&format=json&no_html=1&skip_disambig=1";
      const resp: any = await requestUrl({ url, method: "GET" } as any);
      if (resp.status < 400) {
        const json =
          typeof resp.json === "function" ? resp.json() : JSON.parse(resp.text || "{}");
        if (json.AbstractText) {
          lines.push(`Answer: ${json.AbstractText}`);
          if (json.AbstractURL) lines.push(`Source: ${json.AbstractURL}`);
        }
        if (json.Answer && typeof json.Answer === "string") {
          lines.push(`Answer: ${json.Answer}`);
        }
        if (json.Definition) {
          lines.push(`Definition: ${json.Definition}`);
          if (json.DefinitionURL) lines.push(`Source: ${json.DefinitionURL}`);
        }
        const topics = flattenDuckTopics(json.RelatedTopics ?? []).slice(0, 8);
        for (const t of topics) {
          const text = (t.Text ?? "").trim();
          const firstUrl = t.FirstURL ?? "";
          if (text) lines.push(`- ${text}${firstUrl ? `\n  ${firstUrl}` : ""}`);
        }
      }
    } catch {
      /* fall through to the HTML endpoint below */
    }

    // 2) Fallback: DuckDuckGo HTML endpoint for real, linkable web results.
    if (lines.length < 2) {
      try {
        const url =
          "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
        const resp: any = await requestUrl({
          url,
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; ObsidianAgenter/1.0; +https://obsidian.md)",
          },
        } as any);
        if (resp.status < 400) {
          const results = parseDuckHtml(String(resp.text ?? "")).slice(0, 8);
          for (const r of results) {
            lines.push(`- ${r.title}\n  ${r.url}${r.snippet ? `\n  ${r.snippet}` : ""}`);
          }
        }
      } catch {
        /* ignore - return whatever we have */
      }
    }

    return lines.length
      ? lines.join("\n")
      : "No web results found. Try a more specific query or ask the provider to use its native web search if available.";
  }

  private async fetchUrl(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url ?? "")) return "Only http/https URLs are supported.";
    try {
      const resp: any = await requestUrl({ url, method: "GET" } as any);
      if (resp.status >= 400) return `Fetch failed: HTTP ${resp.status}`;
      const raw = String(resp.text ?? "");
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
      return truncateText(text || raw, 6000);
    } catch (e: any) {
      return `Fetch failed: ${e?.message ?? String(e)}`;
    }
  }

  private listPlugins(includeDisabled: boolean): string {
    const plugins: any = (this.app as any).plugins;
    const manifests = plugins?.manifests ?? {};
    const enabled = new Set<string>(Object.keys(plugins?.plugins ?? {}));
    const ids = Object.keys(manifests).sort((a, b) => {
      const an = manifests[a]?.name ?? a;
      const bn = manifests[b]?.name ?? b;
      return an.localeCompare(bn);
    });
    const lines = ids
      .filter((id) => includeDisabled || enabled.has(id))
      .map((id) => {
        const m = manifests[id] ?? {};
        return `- ${m.name ?? id} (${id}) — ${enabled.has(id) ? "enabled" : "disabled"}${m.version ? `, v${m.version}` : ""}`;
      });
    return lines.length ? lines.join("\n") : "No installed community plugins were found.";
  }

  private pluginInfo(query: string): string {
    const q = String(query ?? "").toLowerCase().trim();
    if (!q) return "Plugin id or name is required.";
    const plugins: any = (this.app as any).plugins;
    const manifests = plugins?.manifests ?? {};
    const enabled = new Set<string>(Object.keys(plugins?.plugins ?? {}));
    const id = Object.keys(manifests).find((k) => {
      const m = manifests[k] ?? {};
      return k.toLowerCase() === q || String(m.name ?? "").toLowerCase().includes(q);
    });
    if (!id) return `Plugin not found: ${query}`;
    return JSON.stringify({ id, enabled: enabled.has(id), ...manifests[id] }, null, 2);
  }

  private findImages(folder: string, query: string, limit: number): string {
    const root = this.app.vault.getRoot();
    let base: TFolder = root;
    if (folder && folder !== "vault") {
      const f = this.app.vault.getAbstractFileByPath(safeVaultPath(folder));
      if (f instanceof TFolder) base = f;
      else return `Folder not found: ${folder}`;
    }
    const q = String(query ?? "").toLowerCase().trim();
    const out: string[] = [];
    VaultWalker(base, (file) => {
      if (out.length >= limit) return;
      if (!isImageName(file.path)) return;
      if (q && !file.path.toLowerCase().includes(q)) return;
      const stat = (file as any).stat;
      out.push(`- ${file.path}${stat?.size ? ` (${Math.round(stat.size / 1024)} KB)` : ""}`);
    });
    return out.length ? out.join("\n") : "No matching images found.";
  }
}

function flattenDuckTopics(items: any[]): any[] {
  const out: any[] = [];
  for (const item of items) {
    if (item.Topics) out.push(...flattenDuckTopics(item.Topics));
    else out.push(item);
  }
  return out;
}

function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}

function stripHtml(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse organic results out of the DuckDuckGo HTML endpoint. */
function parseDuckHtml(
  html: string
): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const snippets: string[] = [];
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1]));

  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = linkRe.exec(html)) !== null) {
    let href = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep raw href */
      }
    } else if (href.startsWith("//")) {
      href = "https:" + href;
    }
    const title = stripHtml(m[2]);
    if (title && href) out.push({ title, url: href, snippet: snippets[idx] ?? "" });
    idx++;
  }
  return out;
}

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

function safeVaultPath(input: string, markdownOnly = false): string {
  const raw = String(input ?? "").trim().replace(/\\/g, "/");
  if (!raw) throw new Error("A vault-relative path is required.");
  if (/^(?:[a-z]+:|\/|~)/i.test(raw)) throw new Error("Only paths inside the Obsidian vault are allowed.");
  const parts = raw.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error("Parent path traversal (..) is not allowed.");
  const p = parts.join("/");
  const first = (parts[0] ?? "").toLowerCase();
  if ([".obsidian", ".trash", ".agenter-backups"].includes(first)) {
    throw new Error("System and backup folders are protected.");
  }
  if (markdownOnly && !p.toLowerCase().endsWith(".md")) {
    throw new Error("This tool can only access markdown notes (.md). ");
  }
  return p;
}

function clampLimit(value: number, max: number): number {
  const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 50;
  return Math.max(1, Math.min(max, n));
}

function frontmatterTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
  return [];
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const clean = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of clean) {
    current = current ? `${current}/${part}` : part;
    const found = app.vault.getAbstractFileByPath(current);
    if (!found) await app.vault.createFolder(current);
    else if (!(found instanceof TFolder)) throw new Error(`Not a folder: ${current}`);
  }
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx > 0) await ensureFolder(app, path.slice(0, idx));
}

async function createSafetyBackup(app: App, file: TFile, reason: string): Promise<string> {
  const folder = ".agenter-backups";
  // Internal helper intentionally owns this protected folder; model-provided paths never can.
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = file.path.replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_");
  let backup = `${folder}/${safeName}.${reason}.${stamp}.md`;
  if (app.vault.getAbstractFileByPath(backup)) backup = `${folder}/${safeName}.${reason}.${Date.now()}.md`;
  await app.vault.create(backup, await app.vault.read(file));
  return backup;
}

function resolveSibling(file: TFile, name: string): string {
  const dir = file.parent ? file.parent.path : "";
  const clean = name.replace(/^\.\//, "");
  return dir ? `${dir}/${clean}` : clean;
}

function VaultWalker(node: any, visit: (f: TFile) => void) {
  if (node instanceof TFolder) {
    for (const child of node.children) VaultWalker(child, visit);
  } else if (node instanceof TFile) {
    visit(node);
  }
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(binary);
}
