// ── context-meter.ts ──────────────────────────────────────────────────────
// A bar that says how full the model's window is. It is what the harness
// knows, drawn small: the share used, the numbers, where compaction starts,
// and, on a click, what the window is made of and what can be done about it.
// It is a `meter` for assistive technology, with the same sentence as its
// label, and its colour is never the only sign: the percentage is always
// written.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextSnapshot } from "./harness/context-manager";
import { formatTokens } from "./harness/tokens";

export interface ContextMeterOptions {
  /** A thinner bar with only the percentage, for small surfaces. */
  compact?: boolean;
  onCompact?: () => void;
  onReport?: () => void;
  onNewChat?: () => void;
}

export interface MeterContext {
  model?: string;
  busy?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  override: "set by you",
  learned: "learned from the provider's errors",
  api: "reported by the provider",
  catalog: "from the model catalog",
  known: "known for this model",
  default: "assumed: the provider did not say",
};

export function describeSnapshot(s: ContextSnapshot): string {
  const pct = Math.min(999, Math.round(s.fraction * 100));
  const how = s.source === "reported" ? "" : "about ";
  return `Context window ${pct}% full: ${how}${s.used.toLocaleString("en-US")} of ${s.window.toLocaleString("en-US")} tokens.`;
}

export class ContextMeter {
  readonly el: HTMLElement;
  private button: HTMLButtonElement;
  private fill: HTMLElement;
  private mark: HTMLElement;
  private label: HTMLElement;
  private popover: HTMLElement | null = null;
  private last: ContextSnapshot | null = null;
  private context: MeterContext = {};
  private readonly onDocPointer = (event: MouseEvent) => {
    if (this.popover && !this.popover.contains(event.target as Node) && !this.el.contains(event.target as Node)) this.closePopover();
  };
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.popover) {
      this.closePopover();
      this.button.focus();
    }
  };

  constructor(parent: HTMLElement, private readonly options: ContextMeterOptions = {}) {
    const doc = parent.ownerDocument;
    this.el = doc.createElement("div");
    this.el.classList.add("agenter-ctxmeter");
    if (options.compact) this.el.classList.add("is-compact");
    this.el.classList.add("is-empty");

    this.button = doc.createElement("button");
    this.button.type = "button";
    this.button.classList.add("agenter-ctxmeter-btn");
    this.button.setAttribute("role", "meter");
    this.button.setAttribute("aria-valuemin", "0");
    this.button.setAttribute("aria-valuemax", "100");
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", () => this.togglePopover());

    const track = doc.createElement("span");
    track.classList.add("agenter-ctxmeter-track");
    this.fill = doc.createElement("span");
    this.fill.classList.add("agenter-ctxmeter-fill");
    this.mark = doc.createElement("span");
    this.mark.classList.add("agenter-ctxmeter-mark");
    track.append(this.fill, this.mark);

    this.label = doc.createElement("span");
    this.label.classList.add("agenter-ctxmeter-label");

    this.button.append(track, this.label);
    this.el.appendChild(this.button);
    parent.appendChild(this.el);
    doc.addEventListener("mousedown", this.onDocPointer, true);
    doc.addEventListener("keydown", this.onKey, true);
  }

  setVisible(visible: boolean): void {
    this.el.classList.toggle("is-hidden", !visible);
  }

  update(snapshot: ContextSnapshot | null, context: MeterContext = {}): void {
    this.last = snapshot;
    this.context = context;
    if (!snapshot) {
      this.el.classList.add("is-empty");
      this.label.textContent = "";
      return;
    }
    this.el.classList.remove("is-empty");
    const pct = Math.min(100, Math.max(0, snapshot.fraction * 100));
    this.fill.style.width = `${pct}%`;
    const markAt = Math.min(100, (snapshot.trigger / snapshot.window) * 100);
    this.mark.style.left = `${markAt}%`;
    this.mark.classList.toggle("is-off", !snapshot.autoCompact);
    for (const level of ["ok", "warn", "high", "full"]) this.el.classList.toggle(`is-${level}`, snapshot.level === level);
    this.el.classList.toggle("is-estimated", snapshot.source === "estimated");
    this.el.classList.toggle("is-busy", !!context.busy);

    const rounded = Math.round(snapshot.fraction * 100);
    const approx = snapshot.source === "estimated" ? "≈" : "";
    this.label.textContent = this.options.compact
      ? `${approx}${rounded}%`
      : `${approx}${rounded}% · ${formatTokens(snapshot.used)} / ${formatTokens(snapshot.window)}`;
    this.button.setAttribute("aria-valuenow", String(Math.min(100, rounded)));
    const sentence = describeSnapshot(snapshot);
    this.button.setAttribute("aria-label", `${sentence} Press for details.`);
    this.button.setAttribute("aria-valuetext", sentence);
    this.button.title = `${sentence}\nWindow ${SOURCE_LABEL[snapshot.windowSource] ?? ""}.`;
    if (this.popover) this.renderPopover();
  }

  private togglePopover(): void {
    if (this.popover) this.closePopover();
    else this.openPopover();
  }

  private openPopover(): void {
    const doc = this.el.ownerDocument;
    const pop = doc.createElement("div");
    pop.classList.add("agenter-ctxmeter-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Context window details");
    this.popover = pop;
    this.el.appendChild(pop);
    this.renderPopover();
    this.button.setAttribute("aria-expanded", "true");
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.button.setAttribute("aria-expanded", "false");
  }

  private renderPopover(): void {
    const pop = this.popover;
    const s = this.last;
    if (!pop) return;
    pop.textContent = "";
    const doc = pop.ownerDocument;
    const add = (tag: string, cls: string, text?: string, parent: HTMLElement = pop) => {
      const el = doc.createElement(tag);
      el.className = cls;
      if (text !== undefined) el.textContent = text;
      parent.appendChild(el);
      return el;
    };
    if (!s) {
      add("div", "agenter-ctxmeter-pop-title", "Context window");
      add("div", "agenter-ctxmeter-pop-note", "Nothing to show yet.");
      return;
    }
    const head = add("div", "agenter-ctxmeter-pop-head");
    add("strong", "agenter-ctxmeter-pop-title", "Context window", head);
    if (this.context.model) add("span", "agenter-ctxmeter-pop-model", this.context.model, head);

    const pct = Math.round(s.fraction * 100);
    add("div", "agenter-ctxmeter-pop-big", `${s.source === "estimated" ? "≈" : ""}${s.used.toLocaleString("en-US")} of ${s.window.toLocaleString("en-US")} tokens (${pct}%)`);
    add("div", "agenter-ctxmeter-pop-note", `${s.source === "reported" ? "As counted by the provider for the last request." : "Estimated here; the provider's own count replaces it after the next answer."}`);

    const parts: Array<[string, number, string]> = [
      ["Instructions", s.breakdown.system, "is-system"],
      ["Tools", s.breakdown.tools, "is-tools"],
      ["Conversation", s.breakdown.history, "is-history"],
    ];
    if (s.breakdown.pending > 0) parts.push(["What you are typing", s.breakdown.pending, "is-pending"]);
    const stack = add("div", "agenter-ctxmeter-stack");
    stack.setAttribute("aria-hidden", "true");
    for (const [, tokens, cls] of parts) {
      const seg = add("span", `agenter-ctxmeter-seg ${cls}`, undefined, stack);
      seg.style.width = `${Math.max(0, Math.min(100, (tokens / s.window) * 100))}%`;
    }
    const list = add("ul", "agenter-ctxmeter-parts");
    for (const [name, tokens, cls] of parts) {
      const li = add("li", "agenter-ctxmeter-part", undefined, list);
      add("span", `agenter-ctxmeter-dot ${cls}`, undefined, li);
      add("span", "agenter-ctxmeter-part-name", name, li);
      add("span", "agenter-ctxmeter-part-n", formatTokens(tokens), li);
    }

    const facts = add("dl", "agenter-ctxmeter-facts");
    const fact = (k: string, v: string) => {
      add("dt", "", k, facts);
      add("dd", "", v, facts);
    };
    fact("Window", `${formatTokens(s.window)} (${SOURCE_LABEL[s.windowSource] ?? "unknown"})`);
    fact("Next answer may be up to", `${formatTokens(s.maxOutput)} tokens`);
    fact("Compaction", s.autoCompact ? `starts at ${formatTokens(s.trigger)} (${Math.round((s.trigger / s.window) * 100)}%)` : "off");

    const actions = add("div", "agenter-ctxmeter-actions");
    const button = (text: string, handler: (() => void) | undefined, hint: string) => {
      const b = add("button", "agenter-ctxmeter-action", text, actions) as HTMLButtonElement;
      b.type = "button";
      b.title = hint;
      b.disabled = !handler || !!this.context.busy;
      b.addEventListener("click", () => {
        this.closePopover();
        handler?.();
      });
    };
    button("Compact now", this.options.onCompact, "Clear old tool output and summarize the oldest turns");
    button("New chat", this.options.onNewChat, "Start again with an empty window");
    const report = add("button", "agenter-ctxmeter-link", "Copy harness report", pop) as HTMLButtonElement;
    report.type = "button";
    report.addEventListener("click", () => {
      this.options.onReport?.();
    });
  }

  destroy(): void {
    const doc = this.el.ownerDocument;
    doc.removeEventListener("mousedown", this.onDocPointer, true);
    doc.removeEventListener("keydown", this.onKey, true);
    this.el.remove();
  }
}
