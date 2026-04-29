import { CustomEditor, type ExtensionContext, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import type { MoonpiMode } from "./types.js";

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
