import type {
  AutoPhase,
  MoonpiMode,
  MoonpiSnapshot,
  SprintLoopState,
  TodoItem,
  TodoStatus,
} from "./types.js";

export class MoonpiState {
  mode: MoonpiMode = "auto";
  autoPhase: AutoPhase = "plan";
  todos: TodoItem[] = [];
  nextTodoId = 1;
  readFiles = new Set<string>();
  endConversationRequested = false;
  sprintLoop: SprintLoopState | undefined;

  restore(snapshot: MoonpiSnapshot | undefined): void {
    if (!snapshot) return;
    this.mode = snapshot.mode;
    this.autoPhase = snapshot.autoPhase;
    this.todos = snapshot.todos.map((item) => ({ ...item }));
    this.nextTodoId = snapshot.nextTodoId;
    this.readFiles = new Set(snapshot.readFiles);
    this.endConversationRequested = snapshot.endConversationRequested;
    this.sprintLoop = snapshot.sprintLoop ? { ...snapshot.sprintLoop } : undefined;
  }

  snapshot(): MoonpiSnapshot {
    const snapshot: MoonpiSnapshot = {
      mode: this.mode,
      autoPhase: this.autoPhase,
      todos: this.todos.map((item) => ({ ...item })),
      nextTodoId: this.nextTodoId,
      readFiles: [...this.readFiles],
      endConversationRequested: this.endConversationRequested,
    };
    if (this.sprintLoop) snapshot.sprintLoop = { ...this.sprintLoop };
    return snapshot;
  }

  resetForUserPrompt(): void {
    this.endConversationRequested = false;
    if (this.mode === "auto" || this.mode === "sprint:plan" || this.mode === "sprint:act") {
      this.autoPhase = "plan";
      this.todos = [];
      this.nextTodoId = 1;
    }
  }

  setMode(mode: MoonpiMode): void {
    this.mode = mode;
    this.endConversationRequested = false;
    if (mode === "auto" || mode === "sprint:plan" || mode === "sprint:act") {
      this.autoPhase = mode === "sprint:act" ? "act" : "plan";
    }
  }

  addTodo(text: string, status: TodoStatus = "todo", notes?: string): TodoItem {
    const todo: TodoItem = {
      id: this.nextTodoId,
      text,
      status,
      ...(notes ? { notes } : {}),
    };
    this.nextTodoId += 1;
    this.todos.push(todo);
    return todo;
  }

  replaceTodos(items: Array<{ text: string; status?: TodoStatus; notes?: string }>): void {
    this.todos = [];
    this.nextTodoId = 1;
    for (const item of items) {
      this.addTodo(item.text, item.status ?? "todo", item.notes);
    }
  }

  updateTodo(id: number, patch: { text?: string; status?: TodoStatus; notes?: string }): TodoItem | undefined {
    const todo = this.todos.find((item) => item.id === id);
    if (!todo) return undefined;
    if (patch.text !== undefined) todo.text = patch.text;
    if (patch.status !== undefined) todo.status = patch.status;
    if (patch.notes !== undefined) {
      if (patch.notes) {
        todo.notes = patch.notes;
      } else {
        delete todo.notes;
      }
    }
    return todo;
  }

  removeTodo(id: number): boolean {
    const before = this.todos.length;
    this.todos = this.todos.filter((item) => item.id !== id);
    return this.todos.length !== before;
  }

  clearTodos(): void {
    this.todos = [];
    this.nextTodoId = 1;
  }

  markRead(filePath: string): void {
    this.readFiles.add(filePath);
  }

  hasRead(filePath: string): boolean {
    return this.readFiles.has(filePath);
  }
}

export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "No TODO items.";
  return todos
    .map((todo) => {
      const statusSymbol = todo.status === "done" ? "✓" : todo.status === "in_progress" ? "~" : " ";
      const notes = todo.notes ? ` (${todo.notes})` : "";
      return `[${statusSymbol}] ${todo.text}${notes}`;
    })
    .join("\n");
}
