export type MoonpiMode = "plan" | "act" | "auto" | "fast" | "sprint:plan" | "sprint:act";

export type AutoPhase = "plan" | "act";

export type TodoStatus = "todo" | "in_progress" | "done" | "blocked";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  notes?: string;
}

export interface SprintLoopState {
  sprintNumber: number;
  currentPhaseId?: string;
  pendingNextPhaseId?: string;
}

export interface MoonpiSnapshot {
  mode: MoonpiMode;
  autoPhase: AutoPhase;
  todos: TodoItem[];
  nextTodoId: number;
  readFiles: string[];
  endConversationRequested: boolean;
  /** Relative file paths selected by /pick for project context injection. Undefined means use default context file matches. */
  selectedContextFilePaths?: string[];
  sprintLoop?: SprintLoopState;
}

export interface MoonpiConfig {
  defaultMode: MoonpiMode;
  preserveExternalTools: boolean;
  contextFiles: {
    enabled: boolean;
    fileNames: string[];
    maxTotalBytes: number;
    /** Maximum directory depth to scan from cwd for default context files and /pick. */
    maxDepth: number;
    /** Maximum filesystem entries to inspect before stopping discovery/tree building. */
    maxScannedEntries: number;
    /** Maximum default context files to auto-select when no /pick selection exists. */
    maxDefaultFiles: number;
    ignoreDirs: string[];
  };
  guards: {
    cwdOnly: boolean;
    readBeforeWrite: boolean;
  };
  keybindings: {
    cycleNext: string;
    cyclePrevious: string;
  };
}
