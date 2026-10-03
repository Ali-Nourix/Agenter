import { App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import AgenterPlugin from "../main";
import { AgentOrchestrator, ChatCallbacks } from "./orchestrator";
import { deriveTitle, getActiveProvider, getActiveSession } from "./settings";
import { ContextMeter } from "./context-meter";
import { copyText } from "./clipboard";

/** Where the contextual popover shows up. */
export type SelectionAnchor = "selection" | "pinned";

export interface PinnedPoint {
  x: number;
  y: number;
}

/** Distance kept between the popover and the viewport edges. */
const EDGE_GAP = 10;
/** Offset from the caret when the popover follows the selection. */
const CARET_GAP = 8;

const QUICK_ACTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["Summarize", "list", "Summarize this selection clearly in concise bullet points."],
  ["Explain", "help-circle", "Explain this selection simply, preserving important details."],
  ["Rewrite", "pencil", "Rewrite this selection to be clearer and more polished."],
  ["Translate", "languages", "Translate this selection. Infer the most useful target language from the current text and conversation."],
  ["Proofread", "spell-check", "Fix grammar, spelling, punctuation, and readability without changing the meaning."],
  ["To tasks", "list-checks", "Convert this selection into a practical Markdown checklist."],
];

/**
 * Contextual chat for the current selection.
 *
 * Deliberately minimal: one header row, one action row, one composer. The
 * selected text stays collapsed behind the word count until it is asked for,
 * and the conversation only appears once there is something to show.
 *
 * Placement is a user choice — either beside the caret, or pinned to a spot
 * the user dragged it to once (see AgentSettings.contextualAnchor).
 */
export class SelectionPopover {
  private static current: SelectionPopover | null = null;

  private readonly app: App;
  private readonly component = new Component();
  private readonly rootEl: HTMLElement;
  private readonly quoteEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly orchestrator: AgentOrchestrator;
  private readonly sourcePath: string;
  private readonly cleanups: Array<() => void> = [];
  private meter: ContextMeter | null = null;

  private busy = false;
  private closed = false;
  private chatting = false;
  private hydrated = false;
  private hasSelectionContext = false;
  private renderTimer: number | null = null;

  /** Closes whatever contextual popover is on screen, if any. */
  static closeCurrent() {
    SelectionPopover.current?.close();
  }

  static isOpen(): boolean {
    return SelectionPopover.current !== null;
  }

  constructor(
    private readonly plugin: AgenterPlugin,
    private readonly selection: string,
    private readonly caret?: PinnedPoint
  ) {
    SelectionPopover.closeCurrent();
    SelectionPopover.current = this;

    this.app = plugin.app;
    this.component.load();
    this.sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    this.orchestrator = new AgentOrchestrator(this.app, plugin.settings, plugin.harness);
    this.orchestrator.setAccessScope({
      mode: this.sourcePath ? "note" : "none",
      notePath: this.sourcePath || undefined,
      folderPath: this.sourcePath.includes("/")
        ? this.sourcePath.slice(0, this.sourcePath.lastIndexOf("/"))
        : "",
    });
    // Continue the main panel's conversation instead of starting blank.
    const session = getActiveSession(plugin.settings);
    this.orchestrator.setMessages(
      session.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    );

    const root = createDiv({ cls: "agenter-ctx" });
    this.rootEl = root;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Agenter contextual chat");

    // ---------------------------------------------------------- header
    const head = root.createDiv({ cls: "agenter-ctx-head" });
    const mark = head.createSpan({ cls: "agenter-ctx-mark" });
    setIcon(mark, "sparkles");

    const words = this.selection.trim().split(/\s+/).filter(Boolean).length;
    this.countEl = head.createEl("button", {
      cls: "agenter-ctx-count",
      text: `${words} ${words === 1 ? "word" : "words"} selected`,
      attr: { type: "button", "aria-expanded": "false" },
    });
    this.countEl.title = "Show the selected text";
    this.countEl.addEventListener("click", () => this.toggleQuote());

    const pinBtn = head.createEl("button", {
      cls: "agenter-ctx-icon",
      attr: { type: "button", "aria-label": "Pin this spot" },
    });
    this.renderPinButton(pinBtn);
    pinBtn.addEventListener("click", () => this.togglePinned(pinBtn));

    const mainBtn = head.createEl("button", {
      cls: "agenter-ctx-icon",
      attr: { type: "button", "aria-label": "Continue in the main panel" },
    });
    setIcon(mainBtn, "panel-right");
    mainBtn.addEventListener("click", () => void this.handOff());

    const closeBtn = head.createEl("button", {
      cls: "agenter-ctx-icon",
      attr: { type: "button", "aria-label": "Close" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());

    // ------------------------------------------------- collapsed quote
    this.quoteEl = root.createDiv({ cls: "agenter-ctx-quote" });

    // ----------------------------------------------------- transcript
    this.logEl = root.createDiv({ cls: "agenter-ctx-log" });

    // ---------------------------------------------------- action chips
    this.actionsEl = root.createDiv({ cls: "agenter-ctx-actions" });
    this.buildActions();

    // ---------------------------------------------- how full the window is
    const meterRow = root.createDiv({ cls: "agenter-ctx-meter-row" });
    this.meter = new ContextMeter(meterRow, { compact: true, onReport: () => void this.copyReport() });
    this.meter.setVisible(plugin.settings.showContextMeter !== false);

    // -------------------------------------------------------- composer
    const composer = root.createDiv({ cls: "agenter-ctx-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "agenter-ctx-input",
      attr: { rows: "1", placeholder: "Ask about the selection…" },
    });
    this.sendBtn = composer.createEl("button", {
      cls: "agenter-ctx-send",
      attr: { type: "button", "aria-label": "Send" },
    });
    setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.addEventListener("click", () => void this.run(this.inputEl.value));
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.run(this.inputEl.value);
      }
      if (e.key === "Escape") this.close();
    });
    this.inputEl.addEventListener("input", () => {
      this.autoGrowInput();
      this.refreshMeter();
    });

    document.body.appendChild(root);
    this.makeDraggable(head);
    this.place();
    this.refreshMeter();

    // Reposition instead of drifting off-screen when the window changes.
    const onResize = () => this.place();
    window.addEventListener("resize", onResize);
    this.cleanups.push(() => window.removeEventListener("resize", onResize));

    // A click anywhere else dismisses it — but not the click that opened it.
    const onPointerDown = (ev: MouseEvent) => {
      if (!root.contains(ev.target as Node)) this.close();
    };
    const armTimer = window.setTimeout(
      () => document.addEventListener("mousedown", onPointerDown, true),
      0
    );
    this.cleanups.push(() => {
      window.clearTimeout(armTimer);
      document.removeEventListener("mousedown", onPointerDown, true);
    });
  }

  // ============================================================ layout

  /** Places the popover either beside the caret or on the pinned spot. */
  private place() {
    if (this.closed) return;
    const rect = this.rootEl.getBoundingClientRect();
    const maxLeft = Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
    const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);

    let left: number;
    let top: number;

    if (this.plugin.settings.contextualAnchor === "pinned" || !this.caret) {
      const pinned = this.pinnedPoint(rect);
      left = pinned.x;
      top = pinned.y;
    } else {
      left = this.caret.x + CARET_GAP;
      top = this.caret.y + CARET_GAP;
      // Flip above the caret when there is no room below it.
      if (top > maxTop) top = Math.max(EDGE_GAP, this.caret.y - rect.height - CARET_GAP);
    }

    this.rootEl.style.setProperty("--agenter-ctx-left", `${clamp(left, EDGE_GAP, maxLeft)}px`);
    this.rootEl.style.setProperty("--agenter-ctx-top", `${clamp(top, EDGE_GAP, maxTop)}px`);
  }

  /** The saved spot, defaulting to the bottom-right corner on first use. */
  private pinnedPoint(rect: DOMRect): PinnedPoint {
    const saved = this.plugin.settings.contextualPinned;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
    return {
      x: window.innerWidth - rect.width - 24,
      y: window.innerHeight - rect.height - 72,
    };
  }

  /** Dragging the header moves the popover and remembers where it landed. */
  private makeDraggable(handle: HTMLElement) {
    handle.addClass("agenter-ctx-drag");
    const onDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest("button")) return;
      const rect = this.rootEl.getBoundingClientRect();
      const offsetX = ev.clientX - rect.left;
      const offsetY = ev.clientY - rect.top;
      let moved = false;
      ev.preventDefault();

      const onMove = (move: MouseEvent) => {
        moved = true;
        this.rootEl.addClass("is-dragging");
        const width = this.rootEl.offsetWidth;
        const height = this.rootEl.offsetHeight;
        const x = clamp(move.clientX - offsetX, EDGE_GAP, Math.max(EDGE_GAP, window.innerWidth - width - EDGE_GAP));
        const y = clamp(move.clientY - offsetY, EDGE_GAP, Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP));
        this.rootEl.style.setProperty("--agenter-ctx-left", `${x}px`);
        this.rootEl.style.setProperty("--agenter-ctx-top", `${y}px`);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        this.rootEl.removeClass("is-dragging");
        if (!moved) return;
        // Dropping it somewhere is the gesture for "always show it here".
        const dropped = this.rootEl.getBoundingClientRect();
        this.plugin.settings.contextualAnchor = "pinned";
        this.plugin.settings.contextualPinned = { x: dropped.left, y: dropped.top };
        void this.plugin.saveSettings();
        this.rootEl
          .querySelectorAll<HTMLElement>(".agenter-ctx-icon[data-agenter-pin]")
          .forEach((btn) => this.renderPinButton(btn));
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    handle.addEventListener("mousedown", onDown);
  }

  private renderPinButton(btn: HTMLElement) {
    const pinned = this.plugin.settings.contextualAnchor === "pinned";
    btn.dataset.agenterPin = "1";
    btn.toggleClass("is-active", pinned);
    setIcon(btn, pinned ? "pin" : "pin-off");
    btn.setAttribute(
      "aria-label",
      pinned ? "Pinned — click to follow the selection" : "Follow selection — click to pin here"
    );
    btn.title = btn.getAttribute("aria-label") ?? "";
  }

  private async togglePinned(btn: HTMLElement) {
    const settings = this.plugin.settings;
    if (settings.contextualAnchor === "pinned") {
      settings.contextualAnchor = "selection";
    } else {
      settings.contextualAnchor = "pinned";
      const rect = this.rootEl.getBoundingClientRect();
      settings.contextualPinned = { x: rect.left, y: rect.top };
    }
    await this.plugin.saveSettings();
    this.renderPinButton(btn);
    this.place();
  }

  // =========================================================== sections

  private buildActions() {
    for (const [label, icon, instruction] of QUICK_ACTIONS) {
      const btn = this.actionsEl.createEl("button", {
        cls: "agenter-ctx-chip",
        attr: { type: "button" },
      });
      const glyph = btn.createSpan({ cls: "agenter-ctx-chip-icon" });
      setIcon(glyph, icon);
      btn.createSpan({ text: label });
      btn.addEventListener("click", () => void this.run(instruction));
    }

    for (const [key, template] of Object.entries(this.plugin.settings.customPrompts ?? {}).slice(0, 6)) {
      const btn = this.actionsEl.createEl("button", {
        cls: "agenter-ctx-chip is-custom",
        attr: { type: "button" },
      });
      const glyph = btn.createSpan({ cls: "agenter-ctx-chip-icon" });
      setIcon(glyph, "wand");
      btn.createSpan({ text: key.replace(/[-_]/g, " ") });
      btn.title = String(template);
      btn.addEventListener("click", () => {
        const tmpl = String(template);
        void this.run(
          tmpl.includes("{{selection}}")
            ? tmpl.replace(/\{\{\s*selection\s*\}\}/g, this.selection)
            : tmpl
        );
      });
    }
  }

  private toggleQuote() {
    const open = !this.rootEl.hasClass("is-quoting");
    this.rootEl.toggleClass("is-quoting", open);
    this.countEl.setAttribute("aria-expanded", String(open));
    if (open && !this.quoteEl.hasChildNodes()) this.renderMarkdown(this.selection, this.quoteEl);
    window.requestAnimationFrame(() => this.place());
  }

  private autoGrowInput() {
    this.inputEl.style.setProperty("height", "auto");
    const next = Math.min(this.inputEl.scrollHeight, 132);
    this.inputEl.style.setProperty("height", `${next}px`);
  }

  private renderMarkdown(text: string, target: HTMLElement) {
    target.empty();
    target.addClass("markdown-rendered");
    target.dir = /[֐-ࣿ]/.test(text) ? "rtl" : "ltr";
    MarkdownRenderer.render(this.app, text, target, this.sourcePath, this.component).catch(() => {
      target.setText(text);
    });
  }

  private addRow(role: "user" | "assistant" | "status", text: string): HTMLElement {
    const row = this.logEl.createDiv({ cls: `agenter-ctx-row is-${role}` });
    if (role === "status") row.setText(text);
    else {
      row.dataset.raw = text;
      this.renderMarkdown(text, row);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return row;
  }

  /** A copy button on an answer, added once it is complete. Selecting text and Ctrl+C work throughout. */
  private addCopy(row: HTMLElement, raw: string) {
    row.dataset.raw = raw;
    row.querySelector(".agenter-ctx-copy")?.remove();
    const btn = row.createEl("button", { cls: "agenter-ctx-copy", attr: { type: "button", "aria-label": "Copy answer", title: "Copy answer" } });
    setIcon(btn, "copy");
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const ok = await copyText(row.dataset.raw ?? raw);
      setIcon(btn, ok ? "check" : "x");
      btn.setAttribute("aria-label", ok ? "Copied" : "Could not copy");
      window.setTimeout(() => {
        setIcon(btn, "copy");
        btn.setAttribute("aria-label", "Copy answer");
      }, 1600);
    });
  }

  private async copyReport() {
    const ok = await copyText(this.plugin.harnessReport());
    new Notice(ok ? "Harness report copied." : "Could not copy the harness report.");
  }

  /** The bar for the conversation as it stands. */
  refreshMeter(): void {
    if (!this.meter || this.closed) return;
    this.meter.setVisible(this.plugin.settings.showContextMeter !== false);
    const provider = getActiveProvider(this.plugin.settings);
    this.meter.update(this.orchestrator.snapshot(this.inputEl?.value ?? ""), { model: provider ? `${provider.name} · ${provider.model}` : undefined, busy: this.busy });
  }

  static refreshCurrentMeter(): void {
    SelectionPopover.current?.refreshMeter();
  }

  private enterChatMode() {
    if (this.chatting) return;
    this.chatting = true;
    this.rootEl.addClass("is-chatting");
    this.inputEl.placeholder = "Continue here…";
    if (!this.hydrated) {
      this.hydrated = true;
      for (const m of getActiveSession(this.plugin.settings).messages) {
        if (m.role === "user") this.addRow("user", m.content);
        else if (m.role === "assistant" && m.content.trim()) this.addRow("assistant", m.content);
      }
    }
    window.requestAnimationFrame(() => this.place());
  }

  // ================================================================ run

  private async run(question: string) {
    const clean = question.trim();
    if (!clean || this.busy) return;

    this.enterChatMode();
    this.busy = true;
    this.sendBtn.disabled = true;
    this.inputEl.value = "";
    this.autoGrowInput();
    this.addRow("user", clean);
    const typing = this.addRow("status", "Thinking…");

    const prompt =
      this.hasSelectionContext || clean.includes(this.selection)
        ? clean
        : `${clean}\n\n<selected-text>\n${this.selection}\n</selected-text>`;
    this.hasSelectionContext = true;
    this.orchestrator.shouldAbort = () => this.closed;

    let response = "";
    let responseEl: HTMLElement | null = null;
    let reasoningEl: HTMLElement | null = null;
    let reasoningText = "";

    const flush = () => {
      if (responseEl) this.renderMarkdown(response, responseEl);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    };

    const callbacks: ChatCallbacks = {
      onNotice: (notice) => {
        if (notice.kind === "retry" || notice.kind === "compact" || notice.kind === "warning") {
          this.addRow("status", notice.text).addClass("is-notice");
        }
      },
      onStreamReset: () => {
        responseEl?.remove();
        responseEl = null;
        response = "";
      },
      onContext: (snapshot) => this.meter?.update(snapshot, { busy: true }),
      onReasoningToken: (token) => {
        typing.remove();
        if (!reasoningEl) {
          reasoningEl = this.addRow("status", "");
          reasoningEl.addClass("is-reasoning");
        }
        reasoningText += token;
        reasoningEl.setText(reasoningText);
        this.logEl.scrollTop = this.logEl.scrollHeight;
      },
      onAssistantToken: (token) => {
        reasoningEl?.addClass("is-complete");
        typing.remove();
        if (!responseEl) responseEl = this.addRow("assistant", "");
        response += token;
        if (this.renderTimer === null) {
          this.renderTimer = window.setTimeout(() => {
            this.renderTimer = null;
            flush();
          }, 70);
        }
      },
      onToolUse: (name) => {
        typing.remove();
        this.addRow("status", `Using ${name}…`);
      },
      onToolResult: () => {},
      onAccessRequest: (request) =>
        this.requestApproval(
          `Allow ${request.requestedMode} access for this run${request.targetPath ? `: ${request.targetPath}` : ""}`,
          false
        ),
      onApprovalRequest: (call) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          /* an unparsable payload still needs a readable label */
        }
        const verb = call.name.replace(/[-_]/g, " ");
        const path = typeof args.path === "string" ? args.path : "";
        return this.requestApproval(path ? `${verb}: ${path}` : verb, call.name === "trash_note");
      },
      onError: (error) => {
        typing.remove();
        this.addRow("status", `Error: ${error}`).addClass("is-error");
      },
      onDone: () => {
        if (this.renderTimer !== null) {
          window.clearTimeout(this.renderTimer);
          this.renderTimer = null;
        }
        typing.remove();
        flush();
        if (responseEl && response.trim()) this.addCopy(responseEl, response);
        this.busy = false;
        this.sendBtn.disabled = false;
        this.refreshMeter();
        if (!this.closed) this.inputEl.focus();
        void this.persist();
        window.requestAnimationFrame(() => this.place());
      },
    };

    await this.orchestrator.run(prompt, callbacks);
  }

  /** Inline Approve / Reject card; deletions need a second, deliberate click. */
  private requestApproval(label: string, destructive: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const card = this.logEl.createDiv({ cls: "agenter-ctx-approval" });
      if (destructive) card.addClass("is-destructive");
      card.createDiv({ cls: "agenter-ctx-approval-label", text: label });
      const row = card.createDiv({ cls: "agenter-ctx-approval-actions" });
      const reject = row.createEl("button", { text: "Reject", attr: { type: "button" } });
      const approve = row.createEl("button", {
        cls: "is-primary",
        text: destructive ? "Review deletion" : "Approve",
        attr: { type: "button" },
      });
      this.logEl.scrollTop = this.logEl.scrollHeight;
      window.requestAnimationFrame(() => this.place());

      const settle = (ok: boolean) => {
        row.remove();
        card.createDiv({
          cls: `agenter-ctx-approval-status ${ok ? "is-approved" : "is-rejected"}`,
          text: ok ? "Approved" : "Rejected",
        });
        resolve(ok);
      };

      let armed = false;
      let armTimer: number | null = null;
      approve.addEventListener("click", () => {
        if (!destructive) return settle(true);
        if (!armed) {
          armed = true;
          approve.setText("Click again: move to Trash");
          armTimer = window.setTimeout(() => {
            armed = false;
            approve.setText("Review deletion");
          }, 6000);
          return;
        }
        if (armTimer !== null) window.clearTimeout(armTimer);
        settle(true);
      });
      reject.addEventListener("click", () => settle(false));
    });
  }

  // ========================================================= plumbing

  /** Writes the contextual turns back into the shared session. */
  private async persist() {
    const session = getActiveSession(this.plugin.settings);
    const stored: Array<{ role: "user" | "assistant" | "tool"; content: string; toolName?: string }> = [];
    for (const m of this.orchestrator.messages) {
      if (m.role === "user") stored.push({ role: "user", content: m.content ?? "" });
      else if (m.role === "assistant" && (m.content ?? "").trim())
        stored.push({ role: "assistant", content: m.content ?? "" });
      else if (m.role === "tool")
        stored.push({ role: "tool", content: m.content ?? "", toolName: (m as { tool_name?: string }).tool_name });
    }
    if (!stored.length) return;
    session.messages = stored.slice(-200);
    session.updatedAt = Date.now();
    if (session.title === "New chat") session.title = deriveTitle(session.messages);
    await this.plugin.saveSettings();
    this.plugin.activeChatPanel?.reloadActiveSession();
  }

  /**
   * Moves the work to the docked panel. An untouched popover hands over the
   * selection itself; one that already has a conversation hands over that.
   */
  private async handOff() {
    const started = this.chatting;
    if (started) await this.persist();
    this.close();
    await this.plugin.ensureChatOpen();
    if (started) this.plugin.activeChatPanel?.reloadActiveSession();
    else this.plugin.activeChatPanel?.insertPromptFromOutside(this.selection);
  }

  focus() {
    this.inputEl.focus();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (SelectionPopover.current === this) SelectionPopover.current = null;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    for (const cleanup of this.cleanups) cleanup();
    this.meter?.destroy();
    this.meter = null;
    this.component.unload();
    this.rootEl.remove();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Shows the contextual popover for the current selection. */
export function openSelectionPopover(
  plugin: AgenterPlugin,
  selection: string,
  caret?: PinnedPoint
): SelectionPopover | null {
  if (!selection.trim()) {
    new Notice("Select some text first.");
    return null;
  }
  return new SelectionPopover(plugin, selection.trim(), caret);
}
