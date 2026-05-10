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
  "web_search",
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
  syntheticAuthenticated = false;
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
    if (this.config.customEditor) {
      installMoonpiEditor(ctx, () => this.state.mode);
    }
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
    let tools = this.config.preserveExternalTools
      ? [...new Set([...STABLE_MOONPI_TOOLS, ...this.pi.getActiveTools().filter((toolName) => !MOONPI_TOOL_NAMES.has(toolName))])]
      : [...STABLE_MOONPI_TOOLS];

    if (!this.syntheticAuthenticated) {
      tools = tools.filter((t) => t !== "web_search");
    }
    return tools;
  }

  buildModePrompt(): string {
    if (this.state.mode === "auto") return AUTO_MODE_PROMPT;
    if (this.state.mode === "plan") return PLAN_MODE_PROMPT;
    if (this.state.mode === "act") return ACT_MODE_PROMPT;
    if (this.state.mode === "fast") return FAST_MODE_PROMPT;
    if (this.state.mode === "sprint:plan") return SPRINT_PLAN_MODE_PROMPT;
    return SPRINT_ACT_MODE_PROMPT;
  }
}

const PLAN_MODE_PROMPT = `## Plan Mode

You are in Plan mode. This mode is for investigation and planning before implementation.

- Use read, grep, find, and ls to inspect the project.
- Do not use bash, edit, or write; The system blocks those tools in this mode.
- Ask concise clarifying questions with question when a user decision is required.
- Create or update a concrete TODO list with todo before ending the turn.
- Do not implement changes in Plan mode. The TODO list should make the next Act-mode work explicit.`;

const ACT_MODE_PROMPT = `## Act Mode

You are in Act mode. This mode is for implementation.

- Use read, grep, find, ls, bash, edit, and write as needed.
- Use todo when it helps track progress, especially when executing a plan created earlier.
- Ask questions only when blocked by a real user decision.
- Keep changes scoped to the user's request and verify the result when practical.`;

const AUTO_MODE_PROMPT = `## Auto Mode

Auto mode uses this same system prompt for both Plan and Act phases. The system prompt must not change when Auto advances from Plan to Act, so the conversation can keep provider prompt-cache affinity.

Auto begins in Plan phase. In Plan phase:

- Use read, grep, find, and ls to inspect the project.
- Do not use bash, edit, or write; The system blocks those tools until Act phase.
- If the request needs implementation, create a concrete non-empty TODO list with todo.
- If the user only asked a question or no action is needed, call end_conversation instead of creating TODOs.

Creating or updating a non-empty TODO list ends Auto planning. The system then retains the conversation, switches runtime to Act phase, and sends this user message:

Auto mode is switching to Act phase. Execute the TODO list now.

#1 [ ] First task
#2 [ ] Second task
...

That user message is the phase-change signal. After you see it, you are in Act phase:

- Execute the TODO list.
- Use read, grep, find, ls, bash, edit, and write as needed.
- Update TODO statuses with todo as work progresses.
- Ask questions only when blocked by a real user decision.`;

const FAST_MODE_PROMPT = `## Fast Mode

You are in Fast mode. Work directly.

- Use read, grep, find, ls, bash, edit, and write as needed.
- Do not use todo, question, or end_conversation; The system disables those tools in Fast mode.
- Keep the response and edits proportional to the request.`;

const SPRINT_PLAN_MODE_PROMPT = `## Sprint Plan Mode

You are in Sprint Plan mode. The current sprint phase instructions are provided in the conversation, not in this system prompt.

- Work only on the current sprint phase.
- Use read, grep, find, and ls to inspect the project.
- Do not use bash, edit, or write; The system blocks those tools in this mode.
- The question tool is unavailable. Make a reasonable judgment and document assumptions in TODO items when needed.
- Create or update a concrete TODO list with todo before ending the turn.`;

const SPRINT_ACT_MODE_PROMPT = `## Sprint Act Mode

You are in Sprint Act mode. The current sprint phase instructions are provided in the conversation, not in this system prompt.

- Work only on the current sprint phase.
- Execute the TODO list and update TODO statuses with todo as work progresses.
- Use read, grep, find, ls, bash, edit, and write as needed.
- The question tool is unavailable. Make a reasonable judgment when blocked and document important assumptions.
- When the current phase is complete and verified, call end_phase with a concise summary.`;
