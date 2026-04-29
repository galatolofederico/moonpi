import { CustomEditor, type ExtensionContext, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import type { MoonpiMode } from "./types.js";

/**
 * MoonPi crescent ASCII logo with ANSI color support via the theme.
 * Translated from the Python logo.py orbit-note design.
 */
function getMoonpiBanner(theme: Theme): string[] {
  // Color helpers matching the gold/amber moon palette
  const m0 = (t: string) => theme.fg("warning", t); // cream highlight
  const m1 = (t: string) => theme.fg("warning", t); // pale yellow
  const m2 = (t: string) => theme.fg("warning", t); // warm yellow
  const m3 = (t: string) => theme.fg("dim", t);     // amber shadow
  const pi = (t: string) => theme.fg("accent", t);   // bright gold
  const title = (t: string) => theme.fg("accent", t); // bright for moonpi
  const muted = (t: string) => theme.fg("muted", t); // coding agent
  const line = (t: string) => theme.fg("dim", t);    // crescent lines

  return [
    "",
    `${m3("       _.._")}                    ${line(".-.")}`,
    `${m2("     .' .-'")}${m3("`")}              ${line(".-'   '-.")}`,
    `${m1("    /  /")}        ${pi("\u03C0")}       ${title("moonpi")}   ${line(")")}`,
    `${m0("    |  |")}                ${line("'-.   .-'")}`,
    `${m1("    \\  '.___.;")}            ${line("'-'")}   ${muted("coding agent")}`,
    `${m2("     '._  _.'")}`,
    `${m3("        \`\`")}`,
    "",
  ];
}

export function installMoonpiHeader(ctx: ExtensionContext): void {
  ctx.ui.setHeader((_tui, theme) => ({
    render(_width: number): string[] {
      return getMoonpiBanner(theme);
    },
    invalidate() {},
  }));
}

function borderForMode(theme: Theme, mode: MoonpiMode): (text: string) => string {
  switch (mode) {
    case "plan":
      return (text) => theme.fg("warning", text);
    case "act":
      return (text) => theme.fg("success", text);
    case "auto":
      return (text) => theme.fg("accent", text);
    case "fast":
      return (text) => theme.fg("error", text);
  }
}

class MoonpiEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly moonpiTheme: Theme,
    private readonly getMode: () => MoonpiMode,
  ) {
    super(tui, editorTheme, keybindings);
  }

  override render(width: number): string[] {
    this.borderColor = borderForMode(this.moonpiTheme, this.getMode());
    return super.render(width);
  }
}

export function installMoonpiEditor(ctx: ExtensionContext, getMode: () => MoonpiMode): void {
  ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
    return new MoonpiEditor(tui, editorTheme, keybindings, ctx.ui.theme, getMode);
  });
}
