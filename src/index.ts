import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatConfig } from "./config.js";
import { installContextFiles } from "./context-files.js";
import { installGuards } from "./guards.js";
import { MoonpiController } from "./modes.js";
import { installSprintWorkflow } from "./sprint.js";
import { installSynthetic } from "./synthetic.js";
import { installMoonpiTools } from "./tools.js";
import type { MoonpiMode } from "./types.js";

const MODES: MoonpiMode[] = ["plan", "act", "auto", "fast"];

function isMoonpiMode(value: string): value is MoonpiMode {
  return value === "plan" || value === "act" || value === "auto" || value === "fast";
}

export default async function moonpi(pi: ExtensionAPI): Promise<void> {
  const controller = new MoonpiController(pi);

  installMoonpiTools(pi, controller);
  installGuards(pi, controller);
  installContextFiles(pi, controller);
  installSprintWorkflow(pi, controller);
  await installSynthetic(pi);

  pi.registerCommand("moonpi:mode", {
    description: "Switch moonpi mode: plan, act, auto, fast",
    getArgumentCompletions: (prefix) => {
      return MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ label: mode, value: mode }));
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        const selected = await ctx.ui.select("moonpi mode", [...MODES]);
        if (selected && isMoonpiMode(selected)) controller.setMode(ctx, selected);
        return;
      }
      if (!isMoonpiMode(requested)) {
        ctx.ui.notify(`Unknown moonpi mode: ${requested}`, "error");
        return;
      }
      controller.setMode(ctx, requested);
    },
  });

  pi.registerCommand("moonpi:settings", {
    description: "Show effective moonpi settings",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatConfig(controller.config), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    controller.restoreFromSession(ctx);
    controller.installUi(ctx);
    controller.applyMode(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    controller.restoreFromSession(ctx);
    controller.applyMode(ctx);
  });

  pi.on("session_shutdown", async () => {
    controller.disposeUi();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") controller.resetForUserPrompt(ctx);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}

## Moonpi Mode

${controller.buildModePrompt()}`,
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    controller.updateUi(ctx);

    if (controller.state.mode === "plan" && controller.state.todos.length === 0) {
      setImmediate(() => {
        pi.sendUserMessage(
          "Moonpi Plan mode requires a TODO list before the turn can finish. Use moonpi_todo to create the plan now.",
        );
      });
      return;
    }

    if (controller.state.mode !== "auto" || controller.state.autoPhase !== "plan") return;
    if (controller.state.endConversationRequested) {
      controller.state.endConversationRequested = false;
      controller.persist();
      return;
    }
    if (controller.state.todos.length === 0) return;

    controller.switchAutoToAct(ctx);
    setImmediate(() => {
      pi.sendUserMessage("Moonpi Auto mode is switching to Act phase. Execute the TODO list now.");
    });
  });
}
