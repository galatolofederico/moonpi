import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { loadMoonpiConfig } from "./config.js";
import { MoonpiState, formatTodoList } from "./state.js";
import type { MoonpiConfig, MoonpiMode, MoonpiSnapshot } from "./types.js";
import { installMoonpiEditor, installMoonpiHeader } from "./ui.js";

const MODE_ORDER: MoonpiMode[] = ["plan", "act", "auto", "fast"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EDITING_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const TODO_TOOL = "todo";
const QUESTION_TOOL = "question";
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
    installMoonpiHeader(ctx);
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
    const isSprint = this.state.mode === "sprint:plan" || this.state.mode === "sprint:act";
    const phase = this.state.mode === "auto" ? `:${this.state.autoPhase}` : isSprint ? `:${this.state.mode === "sprint:act" ? "act" : "plan"}` : "";
    const modeLabel = isSprint ? "sprint" : this.state.mode;
    const total = this.state.todos.length;
    const done = this.state.todos.filter((todo) => todo.status === "done").length;
    ctx.ui.setStatus("moonpi", ctx.ui.theme.fg("accent", `moonpi ${modeLabel}${phase} ${done}/${total}`));

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
    // sprint:plan — like auto:plan but no question tool
    if (this.state.mode === "sprint:plan") return [...READ_ONLY_TOOLS, TODO_TOOL, END_CONVERSATION_TOOL, ...sprintTools];
    // sprint:act — like auto:act but no question tool
    if (this.state.mode === "sprint:act") return [...EDITING_TOOLS, TODO_TOOL, ...sprintTools];
    if (this.state.autoPhase === "act") return [...EDITING_TOOLS, TODO_TOOL, QUESTION_TOOL, ...sprintTools];
    return [...READ_ONLY_TOOLS, TODO_TOOL, QUESTION_TOOL, END_CONVERSATION_TOOL];
  }

  buildModePrompt(): string {
    const todoText = formatTodoList(this.state.todos);
    const sprintText = this.state.sprintLoop
      ? `\n\nActive sprint loop: sprint ${this.state.sprintLoop.sprintNumber}, phase ${
          this.state.sprintLoop.currentPhaseId ?? "unknown"
        }. When the current phase is complete, call end_phase.`
      : "";
    if (this.state.mode === "fast") {
      return `Moonpi Fast mode is active. Work directly with available editing tools. Do not use TODO or Q&A tools.${sprintText}`;
    }
    if (this.state.mode === "act") {
      return `Moonpi Act mode is active. Editing tools are available. The TODO and Q&A tools are available when useful.${sprintText}\n\nCurrent TODO state:\n${todoText}`;
    }
    if (this.state.mode === "plan") {
      return `Moonpi Plan mode is active. You cannot use bash, write, or edit tools. Explore with read-only tools, ask questions with question when needed, and you must create or update the TODO list with todo before ending the turn.${sprintText}\n\nCurrent TODO state:\n${todoText}`;
    }
    if (this.state.mode === "sprint:plan") {
      return `Moonpi Sprint Plan mode is active. You cannot use bash, write, or edit tools, and the question tool is not available. Explore with read-only tools, you must create or update the TODO list with todo before ending the turn. If something is unclear, make your best judgment and document assumptions in the TODO items.${sprintText}\n\nCurrent TODO state:\n${todoText}`;
    }
    if (this.state.mode === "sprint:act") {
      return `Moonpi Sprint Act mode is active. Editing tools are available but the question tool is not. Execute the TODO list, update TODO statuses with todo as work progresses, and make your best judgment when blocked.${sprintText}\n\nCurrent TODO state:\n${todoText}`;
    }
    if (this.state.autoPhase === "act") {
      return `Moonpi Auto mode is in Act phase. Execute the TODO list, update TODO statuses with todo as work progresses, and ask questions only when blocked.${sprintText}\n\nCurrent TODO state:\n${todoText}`;
    }
    return `Moonpi Auto mode is in Plan phase. In this phase you cannot edit files or execute commands — only read-only tools (read, grep, find, ls), the question tool, and the todo tool are available. Explore the codebase with read-only tools, then choose one of two ways to end this phase:\n\n1. If the user's request requires action (editing, running commands, etc.), create a concrete TODO list with the todo tool. Once a non-empty TODO list is set, the mode automatically switches to Act phase where editing tools are enabled.\n2. If the user only asked a question or no work is needed, call the end_conversation tool instead. This ends the session without switching to Act.\n\nDo not create a TODO list for simple questions — just answer them and call end_conversation. If you need to run commands to gather information (e.g., curl to test API endpoints, running test suites, or any other exploratory command), add those steps to the TODO list — they will be executed in Act phase where bash is available.${sprintText}\n\nCurrent TODO state:\n${todoText}`;
  }
}
