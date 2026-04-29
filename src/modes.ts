import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { loadMoonpiConfig } from "./config.js";
import { MoonpiState, formatTodoList } from "./state.js";
import type { MoonpiConfig, MoonpiMode, MoonpiSnapshot } from "./types.js";
import { installMoonpiEditor } from "./ui.js";

const MODE_ORDER: MoonpiMode[] = ["plan", "act", "auto", "fast"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EDITING_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const TODO_TOOL = "moonpi_todo";
const QUESTION_TOOL = "moonpi_question";
const END_CONVERSATION_TOOL = "end_conversation";
const END_PHASE_TOOL = "end_phase";

type Direction = "next" | "previous";

function entryHasMoonpiSnapshot(entry: SessionEntry): entry is SessionEntry & { customType: "moonpi-state"; data: MoonpiSnapshot } {
  if (entry.type !== "custom") return false;
  const candidate = entry as SessionEntry & { customType?: string; data?: unknown };
  return candidate.customType === "moonpi-state" && typeof candidate.data === "object" && candidate.data !== null;
}

function latestSnapshot(entries: SessionEntry[]): MoonpiSnapshot | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && entryHasMoonpiSnapshot(entry)) return entry.data;
  }
  return undefined;
}

export class MoonpiController {
  readonly state = new MoonpiState();
  config: MoonpiConfig = loadMoonpiConfig(process.cwd());
  private terminalInputUnsubscribe: (() => void) | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  restoreFromSession(ctx: ExtensionContext): void {
    this.config = loadMoonpiConfig(ctx.cwd);
    this.state.mode = this.config.defaultMode;
    this.state.restore(latestSnapshot(ctx.sessionManager.getEntries()));
  }

  persist(): void {
    this.pi.appendEntry("moonpi-state", this.state.snapshot());
  }

  setMode(ctx: ExtensionContext, mode: MoonpiMode): void {
    this.state.setMode(mode);
    this.applyMode(ctx);
    this.persist();
    ctx.ui.notify(`moonpi mode: ${mode}`, "info");
  }

  cycleMode(ctx: ExtensionContext, direction: Direction): void {
    const currentIndex = MODE_ORDER.indexOf(this.state.mode);
    const offset = direction === "next" ? 1 : -1;
    const nextIndex = (currentIndex + offset + MODE_ORDER.length) % MODE_ORDER.length;
    const nextMode = MODE_ORDER[nextIndex] ?? "auto";
    this.setMode(ctx, nextMode);
  }

  resetForUserPrompt(ctx: ExtensionContext): void {
    this.state.resetForUserPrompt();
    this.applyMode(ctx);
    this.persist();
  }

  markEndConversationRequested(): void {
    this.state.endConversationRequested = true;
    this.persist();
  }

  switchAutoToAct(ctx: ExtensionContext): void {
    this.state.autoPhase = "act";
    this.applyMode(ctx);
    this.persist();
  }

  applyMode(ctx: ExtensionContext): void {
    this.pi.setActiveTools(this.getToolsForCurrentMode());
    this.updateUi(ctx);
  }

  installUi(ctx: ExtensionContext): void {
    installMoonpiEditor(ctx, () => this.state.mode);
    this.terminalInputUnsubscribe?.();
    this.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (ctx.ui.getEditorText().length > 0) return undefined;
      if (matchesKey(data, this.config.keybindings.cycleNext as KeyId)) {
        this.cycleMode(ctx, "next");
        return { consume: true };
      }
      if (matchesKey(data, this.config.keybindings.cyclePrevious as KeyId)) {
        this.cycleMode(ctx, "previous");
        return { consume: true };
      }
      return undefined;
    });
  }

  disposeUi(): void {
    this.terminalInputUnsubscribe?.();
    this.terminalInputUnsubscribe = undefined;
  }

  updateUi(ctx: ExtensionContext): void {
    const phase = this.state.mode === "auto" ? `:${this.state.autoPhase}` : "";
    const total = this.state.todos.length;
    const done = this.state.todos.filter((todo) => todo.status === "done").length;
    ctx.ui.setStatus("moonpi", ctx.ui.theme.fg("accent", `moonpi ${this.state.mode}${phase} ${done}/${total}`));

    if (this.state.mode === "fast" || total === 0) {
      ctx.ui.setWidget("moonpi-todos", undefined);
      return;
    }
    ctx.ui.setWidget("moonpi-todos", formatTodoList(this.state.todos).split("\n"), { placement: "aboveEditor" });
  }

  getToolsForCurrentMode(): string[] {
    const sprintTools = this.state.sprintLoop ? [END_PHASE_TOOL] : [];
    if (this.state.mode === "fast") return [...EDITING_TOOLS, ...sprintTools];
    if (this.state.mode === "act") return [...EDITING_TOOLS, TODO_TOOL, QUESTION_TOOL, ...sprintTools];
    if (this.state.mode === "plan") return [...READ_ONLY_TOOLS, TODO_TOOL, QUESTION_TOOL];
    if (this.state.autoPhase === "act") return [...EDITING_TOOLS, TODO_TOOL, QUESTION_TOOL, ...sprintTools];
    return [...READ_ONLY_TOOLS, TODO_TOOL, QUESTION_TOOL, END_CONVERSATION_TOOL];
  }

  buildModePrompt(): string {
    const todoText = formatTodoList(this.state.todos);
    if (this.state.mode === "fast") {
      return "Moonpi Fast mode is active. Work directly with available editing tools. Do not use TODO or Q&A tools.";
    }
    if (this.state.mode === "act") {
      return `Moonpi Act mode is active. Editing tools are available. The TODO and Q&A tools are available when useful.\n\nCurrent TODO state:\n${todoText}`;
    }
    if (this.state.mode === "plan") {
      return `Moonpi Plan mode is active. You cannot use bash, write, or edit tools. Explore with read-only tools, ask questions with moonpi_question when needed, and you must create or update the TODO list with moonpi_todo before ending the turn.\n\nCurrent TODO state:\n${todoText}`;
    }
    if (this.state.autoPhase === "act") {
      return `Moonpi Auto mode is in Act phase. Execute the TODO list, update TODO statuses with moonpi_todo as work progresses, and ask questions only when blocked.\n\nCurrent TODO state:\n${todoText}`;
    }
    return `Moonpi Auto mode is in Plan phase. First inspect and plan. Use moonpi_todo to produce a concrete TODO list before any edits. If the user only asked a question or no work is needed, call end_conversation instead of producing a TODO list.\n\nCurrent TODO state:\n${todoText}`;
  }
}
