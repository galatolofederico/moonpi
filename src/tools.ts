import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, Key, matchesKey, Text, truncateToWidth, type EditorTheme } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import type { MoonpiController } from "./modes.js";
import { formatTodoList } from "./state.js";
import type { TodoStatus } from "./types.js";

const TodoStatusSchema = StringEnum(["todo", "in_progress", "done", "blocked"] as const);

const TodoItemInputSchema = Type.Object({
  text: Type.String({ description: "Task text" }),
  status: Type.Optional(TodoStatusSchema),
  notes: Type.Optional(Type.String({ description: "Optional task notes" })),
});

const TodoParamsSchema = Type.Object({
  action: StringEnum(["list", "set", "add", "update", "remove", "clear"] as const),
  items: Type.Optional(Type.Array(TodoItemInputSchema, { description: "Items for set" })),
  id: Type.Optional(Type.Number({ description: "TODO id for update/remove" })),
  text: Type.Optional(Type.String({ description: "TODO text for add/update" })),
  status: Type.Optional(TodoStatusSchema),
  notes: Type.Optional(Type.String({ description: "TODO notes for add/update" })),
});

type TodoParams = Static<typeof TodoParamsSchema>;

interface TodoDetails {
  todos: ReturnType<MoonpiController["state"]["snapshot"]>["todos"];
}

const QuestionTypeSchema = StringEnum(["single", "multiple", "open"] as const);

const QuestionParamsSchema = Type.Object({
  question: Type.String({ description: "Question to ask the user" }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Candidate answers. Required for single and multiple types, ignored for open type." })),
  type: Type.Optional(QuestionTypeSchema),
  allowCustom: Type.Optional(Type.Boolean({ description: "Deprecated: free-text is always included for single and multiple types. Ignored." })),
});

type QuestionParams = Static<typeof QuestionParamsSchema>;

const FREE_TEXT_OPTION = "Other (type your answer)";

type QuestionType = "single" | "multiple" | "open";

interface QuestionDetails {
  type: QuestionType;
  /** For single: single string (or null). For multiple: array of strings. For open: single string (or null). */
  answer: string | null;
  answers: string[];
  /** Which answers were free-text (not from the provided options). */
  customAnswers: string[];
}

interface MultiSelectResult {
  answers: string[];
  customAnswers: string[];
  cancelled: boolean;
}

const EndConversationParamsSchema = Type.Object({
  reason: Type.Optional(Type.String({ description: "Why no TODO/action phase is needed" })),
});

export function installMoonpiTools(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.registerTool({
    name: "todo",
    label: "moonpi todo",
    description:
      "Create, replace, update, remove, clear, or list the active TODO list. Always use this in Plan mode and Auto planning before implementation.",
    promptSnippet: "Manage the required moonpi TODO list",
    promptGuidelines: [
      "Use todo to create concrete, ordered TODO items before acting in Plan or Auto planning.",
      "When a TODO item changes, update it with todo so the current list is returned.",
    ],
    parameters: TodoParamsSchema,
    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      const wasAutoPlanning = controller.state.mode === "auto" && controller.state.autoPhase === "plan";
      if (controller.state.mode === "fast") {
        return {
          content: [{ type: "text", text: "todo is disabled in Fast mode." }],
          details: { todos: controller.state.todos } satisfies TodoDetails,
        };
      }

      switch (params.action) {
        case "set":
          controller.state.replaceTodos(params.items ?? []);
          break;
        case "add":
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: text is required for action add." }],
              details: { todos: controller.state.todos } satisfies TodoDetails,
            };
          }
          controller.state.addTodo(params.text, params.status ?? "todo", params.notes);
          break;
        case "update":
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: id is required for action update." }],
              details: { todos: controller.state.todos } satisfies TodoDetails,
            };
          }
          {
            const patch: { text?: string; status?: TodoStatus; notes?: string } = {};
            if (params.text !== undefined) patch.text = params.text;
            if (params.status !== undefined) patch.status = params.status;
            if (params.notes !== undefined) patch.notes = params.notes;
            if (!controller.state.updateTodo(params.id, patch)) {
              return {
                content: [{ type: "text", text: `Error: TODO #${params.id} not found.` }],
                details: { todos: controller.state.todos } satisfies TodoDetails,
              };
            }
          }
          break;
        case "remove":
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: id is required for action remove." }],
              details: { todos: controller.state.todos } satisfies TodoDetails,
            };
          }
          controller.state.removeTodo(params.id);
          break;
        case "clear":
          controller.state.clearTodos();
          break;
        case "list":
          break;
      }

      const shouldEndAutoPlan = wasAutoPlanning && params.action !== "list" && controller.state.todos.length > 0;
      controller.updateUi(ctx);
      controller.persist();
      const suffix = shouldEndAutoPlan
        ? "\n\nMoonpi Auto planning is complete. The next turn will switch to Act mode with editing tools enabled."
        : "";
      return {
        content: [{ type: "text", text: `Current TODO list:\n${formatTodoList(controller.state.todos)}${suffix}` }],
        details: { todos: controller.state.todos } satisfies TodoDetails,
        terminate: shouldEndAutoPlan,
      };
    },
    renderResult(result, _options, theme) {
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });

  pi.registerTool({
    name: "question",
    label: "moonpi question",
    description:
      "Ask the user a clarifying question when a decision is required before continuing. Supports three types: 'single' (pick one option, default), 'multiple' (pick several options), and 'open' (free-text answer). For single and multiple types, a free-text 'Other' option is always included automatically.",
    promptSnippet: "Ask the user a concise clarifying question",
    promptGuidelines: [
      "Use type 'single' when the user must pick exactly one option.",
      "Use type 'multiple' when the user can pick several options.",
      "Use type 'open' when you need a free-text answer with no predefined options.",
      "A free-text 'Other (type your answer)' option is always included for single and multiple types.",
    ],
    parameters: QuestionParamsSchema,
    async execute(_toolCallId, params: QuestionParams, _signal, _onUpdate, ctx) {
      if (controller.state.mode === "fast") {
        return { content: [{ type: "text", text: "question is disabled in Fast mode." }], details: undefined };
      }
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "Error: interactive UI is not available." }], details: undefined };
      }

      const qType: QuestionType = params.type ?? "single";

      // Open type: simple text input
      if (qType === "open") {
        const custom = await ctx.ui.input(params.question, "Your answer");
        const detail: QuestionDetails = {
          type: "open",
          answer: custom ?? null,
          answers: custom ? [custom] : [],
          customAnswers: custom ? [custom] : [],
        };
        return {
          content: [{ type: "text", text: custom ? `User answered: ${custom}` : "User did not provide an answer." }],
          details: detail,
        };
      }

      // Single and multiple types require options
      if (!params.options || params.options.length === 0) {
        return {
          content: [{ type: "text", text: "Error: at least one option is required for single/multiple question types." }],
          details: undefined,
        };
      }

      // Single type: select one with always-included free-text option
      if (qType === "single") {
        const options = [...params.options, FREE_TEXT_OPTION];
        const selected = await ctx.ui.select(params.question, options);
        if (!selected) {
          const detail: QuestionDetails = { type: "single", answer: null, answers: [], customAnswers: [] };
          return { content: [{ type: "text", text: "User cancelled the question." }], details: detail };
        }
        if (selected === FREE_TEXT_OPTION) {
          const custom = await ctx.ui.input(params.question, "Your answer");
          const detail: QuestionDetails = {
            type: "single",
            answer: custom ?? null,
            answers: custom ? [custom] : [],
            customAnswers: custom ? [custom] : [],
          };
          return {
            content: [{ type: "text", text: custom ? `User answered: ${custom}` : "User did not provide an answer." }],
            details: detail,
          };
        }
        const detail: QuestionDetails = {
          type: "single",
          answer: selected,
          answers: [selected],
          customAnswers: [],
        };
        return { content: [{ type: "text", text: `User answered: ${selected}` }], details: detail };
      }

      // Multiple type: custom checkbox UI with always-included free-text option
      const allOptions = [...params.options, FREE_TEXT_OPTION];
      const result = await ctx.ui.custom<MultiSelectResult>((tui, theme, _kb, done) => {
        let cursorIndex = 0;
        const selected = new Set<number>();
        let inputMode = false;
        let cachedLines: string[] | undefined;

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);
        editor.onSubmit = (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            // Find or add the free-text option index and mark it
            selected.add(allOptions.length - 1); // FREE_TEXT_OPTION index
            // Store the custom text as metadata on that index
            customTexts.set(allOptions.length - 1, trimmed);
          }
          inputMode = false;
          editor.setText("");
          cachedLines = undefined;
          tui.requestRender();
        };

        const customTexts = new Map<number, string>();

        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }

        function handleInput(data: string) {
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          if (matchesKey(data, Key.up)) {
            cursorIndex = Math.max(0, cursorIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            cursorIndex = Math.min(allOptions.length - 1, cursorIndex + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.space)) {
            // Toggle selection (but not on free-text option directly — that opens input)
            if (cursorIndex === allOptions.length - 1) {
              // Toggle the "Other" option
              if (selected.has(cursorIndex)) {
                selected.delete(cursorIndex);
                customTexts.delete(cursorIndex);
              } else {
                inputMode = true;
                editor.setText("");
              }
            } else {
              if (selected.has(cursorIndex)) {
                selected.delete(cursorIndex);
              } else {
                selected.add(cursorIndex);
              }
            }
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            if (cursorIndex === allOptions.length - 1 && !selected.has(cursorIndex)) {
              // Enter on "Other" when not yet selected → open input
              inputMode = true;
              editor.setText("");
              refresh();
              return;
            }
            // Submit
            const answers: string[] = [];
            const customs: string[] = [];
            for (const idx of [...selected].sort()) {
              const opt = allOptions[idx];
              if (idx === allOptions.length - 1) {
                const customVal = customTexts.get(idx);
                if (customVal) {
                  answers.push(customVal);
                  customs.push(customVal);
                } else {
                  answers.push(opt);
                  customs.push(opt);
                }
              } else {
                answers.push(opt);
              }
            }
            done({ answers, customAnswers: customs, cancelled: false });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done({ answers: [], customAnswers: [], cancelled: true });
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;
          const lines: string[] = [];
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          add(theme.fg("accent", "─".repeat(width)));
          add(theme.fg("text", ` ${params.question}`));
          lines.push("");

          if (inputMode) {
            for (let i = 0; i < allOptions.length; i++) {
              const isCursor = i === cursorIndex;
              const isChecked = selected.has(i);
              const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
              const box = isChecked ? theme.fg("success", "☑") : theme.fg("dim", "☐");
              const label =
                i === allOptions.length - 1
                  ? theme.fg("accent", `${FREE_TEXT_OPTION} ✎`)
                  : theme.fg("text", allOptions[i]!);
              add(`${prefix}${box} ${label}`);
            }
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) {
              add(` ${line}`);
            }
            lines.push("");
            add(theme.fg("dim", " Enter to submit • Esc to cancel"));
          } else {
            for (let i = 0; i < allOptions.length; i++) {
              const isCursor = i === cursorIndex;
              const isChecked = selected.has(i);
              const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
              const box = isChecked ? theme.fg("success", "☑") : theme.fg("dim", "☐");
              let label: string;
              if (i === allOptions.length - 1) {
                const customVal = customTexts.get(i);
                label = isChecked && customVal
                  ? theme.fg("success", `${FREE_TEXT_OPTION}: ${customVal}`)
                  : theme.fg("accent", FREE_TEXT_OPTION);
              } else {
                label = theme.fg("text", allOptions[i]!);
              }
              add(`${prefix}${box} ${label}`);
            }
            lines.push("");
            const selectedCount = selected.size;
            if (selectedCount > 0) {
              add(theme.fg("dim", ` ${selectedCount} selected • Space toggle • Enter submit • Esc cancel`));
            } else {
              add(theme.fg("dim", " Space toggle • Enter submit • Esc cancel"));
            }
          }

          add(theme.fg("accent", "─".repeat(width)));
          cachedLines = lines;
          return lines;
        }

        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
          },
          handleInput,
        };
      });

      if (result.cancelled) {
        const detail: QuestionDetails = { type: "multiple", answer: null, answers: [], customAnswers: [] };
        return { content: [{ type: "text", text: "User cancelled the question." }], details: detail };
      }

      const detail: QuestionDetails = {
        type: "multiple",
        answer: result.answers.length > 0 ? result.answers.join(", ") : null,
        answers: result.answers,
        customAnswers: result.customAnswers,
      };
      return {
        content: [{ type: "text", text: `User answered: ${result.answers.join(", ")}` }],
        details: detail,
      };
    },
  });

  pi.registerTool({
    name: "end_conversation",
    label: "end conversation",
    description:
      "In Moonpi Auto planning, call this instead of creating TODOs when the user only asked a question or no action is needed.",
    promptSnippet: "End Auto planning without switching to Act",
    parameters: EndConversationParamsSchema,
    async execute(_toolCallId, params: Static<typeof EndConversationParamsSchema>) {
      controller.markEndConversationRequested();
      const reason = params.reason ? ` Reason: ${params.reason}` : "";
      return {
        content: [{ type: "text", text: `Conversation ended without an Act phase.${reason}` }],
        details: { reason: params.reason ?? null },
        terminate: true,
      };
    },
  });
}
