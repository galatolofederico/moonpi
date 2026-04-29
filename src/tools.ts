import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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

const QuestionParamsSchema = Type.Object({
  question: Type.String({ description: "Question to ask the user" }),
  options: Type.Array(Type.String(), { description: "Candidate answers. Include clear, mutually exclusive choices." }),
  allowCustom: Type.Optional(Type.Boolean({ description: "Whether to allow a free-form answer" })),
});

type QuestionParams = Static<typeof QuestionParamsSchema>;

const EndConversationParamsSchema = Type.Object({
  reason: Type.Optional(Type.String({ description: "Why no TODO/action phase is needed" })),
});

export function installMoonpiTools(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.registerTool({
    name: "moonpi_todo",
    label: "moonpi todo",
    description:
      "Create, replace, update, remove, clear, or list the active TODO list. Always use this in Plan mode and Auto planning before implementation.",
    promptSnippet: "Manage the required moonpi TODO list",
    promptGuidelines: [
      "Use moonpi_todo to create concrete, ordered TODO items before acting in Plan or Auto planning.",
      "When a TODO item changes, update it with moonpi_todo so the current list is returned.",
    ],
    parameters: TodoParamsSchema,
    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      if (controller.state.mode === "fast") {
        return {
          content: [{ type: "text", text: "moonpi_todo is disabled in Fast mode." }],
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

      controller.applyMode(ctx);
      controller.persist();
      return {
        content: [{ type: "text", text: `Current TODO list:\n${formatTodoList(controller.state.todos)}` }],
        details: { todos: controller.state.todos } satisfies TodoDetails,
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
    name: "moonpi_question",
    label: "moonpi question",
    description: "Ask the user a clarifying question when a decision is required before continuing.",
    promptSnippet: "Ask the user a concise clarifying question",
    parameters: QuestionParamsSchema,
    async execute(_toolCallId, params: QuestionParams, _signal, _onUpdate, ctx) {
      if (controller.state.mode === "fast") {
        return { content: [{ type: "text", text: "moonpi_question is disabled in Fast mode." }], details: undefined };
      }
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "Error: interactive UI is not available." }], details: undefined };
      }
      if (params.options.length === 0) {
        return { content: [{ type: "text", text: "Error: at least one option is required." }], details: undefined };
      }

      const options = params.allowCustom ? [...params.options, "Type a custom answer"] : params.options;
      const selected = await ctx.ui.select(params.question, options);
      if (!selected) {
        return { content: [{ type: "text", text: "User cancelled the question." }], details: { answer: null } };
      }
      if (params.allowCustom && selected === "Type a custom answer") {
        const custom = await ctx.ui.input(params.question, "Answer");
        return {
          content: [{ type: "text", text: custom ? `User answered: ${custom}` : "User did not provide an answer." }],
          details: { answer: custom ?? null },
        };
      }
      return { content: [{ type: "text", text: `User answered: ${selected}` }], details: { answer: selected } };
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
