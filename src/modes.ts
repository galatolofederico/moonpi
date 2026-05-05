import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { loadMoonpiConfig } from "./config.js";
import { MoonpiState, formatTodoList } from "./state.js";
import type { MoonpiConfig, MoonpiMode, MoonpiSnapshot } from "./types.js";
import { installMoonpiEditor, installMoonpiHeader } from "./ui.js";

const MODE_ORDER: MoonpiMode[] = ["plan", "act", "auto", "fast"];
const STABLE_MOONPI_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "todo",
  "question",
  "end_conversation",
  "end_phase",
];
const MOONPI_TOOL_NAMES = new Set(STABLE_MOONPI_TOOLS);
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

  isPlanPhase(): boolean {
    return this.state.mode === "plan" || this.state.mode === "sprint:plan" || (this.state.mode === "auto" && this.state.autoPhase === "plan");
  }

  isQuestionAllowed(): boolean {
    return this.state.mode !== "fast" && this.state.mode !== "sprint:plan" && this.state.mode !== "sprint:act";
  }

  isEndConversationAllowed(): boolean {
    return this.state.mode === "auto" && this.state.autoPhase === "plan";
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
    if (!this.config.preserveExternalTools) return STABLE_MOONPI_TOOLS;
    const externalTools = this.pi.getActiveTools().filter((toolName) => !MOONPI_TOOL_NAMES.has(toolName));
    return [...new Set([...STABLE_MOONPI_TOOLS, ...externalTools])];
  }

  buildModePrompt(): string {
    return `Moonpi keeps the same advertised tool set across modes to preserve provider prompt-cache affinity. Mode rules are enforced when tools are called.

## Moonpi Workflow

- Plan phases are moonpi:plan, moonpi:auto plan, and moonpi:sprint plan. In Plan phases, inspect with read, grep, find, and ls. Do not use bash, edit, or write; those calls are blocked. Create or update a concrete TODO list with todo before ending the turn.
- Act phases are moonpi:act, moonpi:auto act, and moonpi:sprint act. In Act phases, execute the TODO list, update TODO statuses with todo as work progresses, and ask questions only when blocked.
- Auto mode starts in Plan phase. If the request needs action, create a non-empty TODO list; Moonpi then switches to Act with the planning conversation retained. If the user only asked a question or no action is needed, call end_conversation instead of creating TODOs.
- Fast mode is direct execution. Work with read, grep, find, ls, bash, edit, and write. todo, question, and end_conversation are disabled in Fast mode.
- Sprint modes are managed by /sprint:loop. In sprint planning, make a TODO list for the current phase. In sprint acting, complete the phase and call end_phase when the phase is done.
- question is unavailable in Fast and Sprint modes. end_conversation is only valid in Auto Plan. end_phase is only useful when a sprint loop is active.
- TODO state is not embedded in the system prompt. Use todo with action "list" when you need the current TODO list.
- If a tool returns a Moonpi mode error, respect the error, adapt to the active phase, and continue with allowed tools.

Current Moonpi runtime state: ${this.describeCurrentState()}.`;
  }

  private describeCurrentState(): string {
    if (this.state.mode === "auto") return `moonpi:auto ${this.state.autoPhase}`;
    if (this.state.mode === "sprint:plan" || this.state.mode === "sprint:act") {
      const phase = this.state.mode === "sprint:act" ? "act" : "plan";
      const sprint = this.state.sprintLoop;
      if (!sprint) return `moonpi:sprint ${phase}`;
      return `moonpi:sprint ${phase}, sprint ${sprint.sprintNumber}, phase ${sprint.currentPhaseId ?? "unknown"}`;
    }
    return `moonpi:${this.state.mode}`;
  }
}
