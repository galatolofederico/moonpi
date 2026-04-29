import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { MoonpiController } from "./modes.js";

interface Phase {
  id: string;
  title: string;
  startLine: number;
  endLine: number;
  section: string;
  complete: boolean;
}

const EndPhaseParamsSchema = Type.Object({
  sprintNumber: Type.Optional(Type.Number({ description: "Sprint number. Defaults to the active sprint loop." })),
  phaseId: Type.Optional(Type.String({ description: "Phase id. Defaults to the active phase." })),
  summary: Type.Optional(Type.String({ description: "Short summary of work completed in this phase." })),
});

type EndPhaseParams = Static<typeof EndPhaseParamsSchema>;

function sprintsDir(cwd: string): string {
  return join(cwd, "sprints");
}

function sprintDir(cwd: string, sprintNumber: number): string {
  return join(sprintsDir(cwd), String(sprintNumber));
}

function tasksPath(cwd: string, sprintNumber: number): string {
  return join(sprintDir(cwd, sprintNumber), "TASKS.md");
}

function sprintPath(cwd: string, sprintNumber: number): string {
  return join(sprintDir(cwd, sprintNumber), "SPRINT.md");
}

function listSprintNumbers(cwd: string): number[] {
  const dir = sprintsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number.parseInt(entry.name, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
}

function nextSprintNumber(cwd: string): number {
  const numbers = listSprintNumbers(cwd);
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

function readTasks(cwd: string, sprintNumber: number): string {
  const filePath = tasksPath(cwd, sprintNumber);
  if (!existsSync(filePath)) throw new Error(`TASKS.md not found for sprint ${sprintNumber}`);
  return readFileSync(filePath, "utf-8");
}

function parsePhases(tasks: string): Phase[] {
  const lines = tasks.split("\n");
  const headings: Array<{ id: string; title: string; line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^## Phase\s+([^:—\-–]+)\s*[:—–-]\s*(.+)$/.exec(lines[index] ?? "");
    if (match) headings.push({ id: match[1]?.trim() ?? "", title: match[2]?.trim() ?? "", line: index });
  }

  return headings.map((heading, index) => {
    const endLine = headings[index + 1]?.line ?? lines.length;
    const section = lines.slice(heading.line, endLine).join("\n");
    return {
      id: heading.id,
      title: heading.title,
      startLine: heading.line,
      endLine,
      section,
      complete: !section.includes("- [ ]"),
    };
  });
}

function nextIncompletePhase(cwd: string, sprintNumber: number): Phase | undefined {
  return parsePhases(readTasks(cwd, sprintNumber)).find((phase) => !phase.complete);
}

function phaseById(cwd: string, sprintNumber: number, phaseId: string): Phase | undefined {
  return parsePhases(readTasks(cwd, sprintNumber)).find((phase) => phase.id === phaseId);
}

function buildPhaseInstruction(sprintNumber: number, phase: Phase): string {
  return `Moonpi sprint loop: complete Sprint ${sprintNumber}, Phase ${phase.id}: ${phase.title}.

Work only on this phase. Update files as needed, run or document the verification listed for this phase, and update TODO items as work progresses. When this phase is complete, call end_phase with sprintNumber ${sprintNumber}, phaseId "${phase.id}", and a concise summary.

Current phase section:

${phase.section}`;
}

function markPhaseComplete(cwd: string, sprintNumber: number, phaseId: string, summary: string | undefined): Phase | undefined {
  const filePath = tasksPath(cwd, sprintNumber);
  const tasks = readTasks(cwd, sprintNumber);
  const lines = tasks.split("\n");
  const phase = parsePhases(tasks).find((candidate) => candidate.id === phaseId);
  if (!phase) return undefined;

  const before = lines.slice(0, phase.startLine);
  const section = lines.slice(phase.startLine, phase.endLine).map((line) => line.replace(/- \[ \]/g, "- [x]"));
  if (summary) {
    section.push("");
    section.push(`Completion notes: ${summary}`);
  }
  const after = lines.slice(phase.endLine);
  writeFileSync(filePath, [...before, ...section, ...after].join("\n"), "utf-8");
  return phase;
}

function continueAfterCompaction(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
  ctx.compact({
    customInstructions: "Moonpi sprint loop completed one phase. Preserve the sprint goal, completed phase summary, and next phase instructions.",
    onComplete: () => pi.sendUserMessage(prompt),
    onError: () => pi.sendUserMessage(prompt),
  });
}

export function installSprintWorkflow(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.registerCommand("sprint:init", {
    description: "Create a moonpi sprint: ask for the objective, then delegate SPRINT.md and TASKS.md creation to the agent",
    handler: async (_args, ctx) => {
      const objective = await ctx.ui.editor("Sprint objective", "");
      if (!objective?.trim()) return;

      const sprintNumber = nextSprintNumber(ctx.cwd);
      const dir = sprintDir(ctx.cwd, sprintNumber);
      mkdirSync(dir, { recursive: true });

      controller.state.sprintLoop = { sprintNumber };
      controller.applyMode(ctx);
      controller.persist();

      pi.sendUserMessage(
        `Create the sprint files for Sprint ${sprintNumber} in ./sprints/${sprintNumber}/.

Sprint objective: ${objective.trim()}

Before writing any files, **ask clarifying questions** using the question tool to understand the objective better. You should ask about:
- Scope and boundaries (what's in scope, what's explicitly out of scope)
- Technical constraints and preferences (frameworks, patterns, existing code to integrate with)
- Acceptance criteria (what does "done" look like?)
- Priority and ordering (what matters most?)
- Any ambiguous aspects of the objective

Only after you have enough clarity, do exactly two things:

1. Write SPRINT.md at ${sprintPath(ctx.cwd, sprintNumber)} — a clear and detailed sprint document that includes:
   - **Goal**: One-sentence summary of what this sprint delivers
   - **Scope**: What's included and excluded
   - **Context**: Relevant background, existing code, dependencies
   - **Constraints**: Technical constraints, patterns to follow, things to avoid
   - **Acceptance Criteria**: Concrete, testable conditions that define "done"
   - **Risks & Open Questions**: Known risks and unresolved items

2. Write TASKS.md at ${tasksPath(ctx.cwd, sprintNumber)} — break the objective into concrete phases with tasks and verification items.

TASKS.md format requirements:
- Each phase must be a level-2 heading: \`## Phase <number>: <title>\` (use a colon between the number and title)
- Within each phase, list tasks as unchecked markdown checkboxes: \`- [ ] Task description\`
- End each phase with a **Verification:** section listing how to confirm the phase is done
- Each phase should be independently completable and verifiable

Example:
\`\`\`
## Phase 1: Project Scaffolding

- [ ] Initialize project structure
- [ ] Create base HTML shell
- [ ] Set up dev server

**Verification:**
- npm run dev loads without errors
\`\`\`

Do not start implementing anything. Only create the sprint planning files.`,
      );
    },
  });

  pi.registerCommand("sprint:loop", {
    description: "Execute the next incomplete phase in the latest sprint, compacting after each phase",
    handler: async (_args, ctx) => {
      const sprints = listSprintNumbers(ctx.cwd);
      if (sprints.length === 0) {
        ctx.ui.notify("No sprints found. Use /sprint:init to create one.", "error");
        return;
      }

      let sprintNumber: number;
      if (sprints.length === 1) {
        sprintNumber = sprints[0]!;
      } else {
        const options = sprints
          .slice()
          .reverse()
          .map((n) => `Sprint ${n}`);
        const selected = await ctx.ui.select("Select sprint", options);
        if (!selected) return;
        const match = /^Sprint (\d+)$/.exec(selected);
        if (!match) return;
        sprintNumber = Number.parseInt(match[1]!, 10);
      }

      let phase: Phase | undefined;
      try {
        phase = nextIncompletePhase(ctx.cwd, sprintNumber);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (!phase) {
        ctx.ui.notify(`Sprint ${sprintNumber} has no incomplete phases.`, "info");
        return;
      }

      controller.state.sprintLoop = { sprintNumber, currentPhaseId: phase.id };
      controller.state.setMode("sprint:plan");
      controller.applyMode(ctx);
      controller.persist();
      pi.sendUserMessage(buildPhaseInstruction(sprintNumber, phase));
    },
  });

  pi.registerTool({
    name: "end_phase",
    label: "end phase",
    description:
      "Finish the active moonpi sprint phase. This marks the phase complete in TASKS.md, then moonpi compacts context and continues with the next phase.",
    promptSnippet: "Finish the active sprint phase",
    parameters: EndPhaseParamsSchema,
    async execute(_toolCallId, params: EndPhaseParams, _signal, _onUpdate, ctx) {
      const sprintNumber = params.sprintNumber ?? controller.state.sprintLoop?.sprintNumber;
      const phaseId = params.phaseId ?? controller.state.sprintLoop?.currentPhaseId;
      if (!sprintNumber || !phaseId) {
        return {
          content: [{ type: "text", text: "Error: no active sprint phase to end." }],
          details: { error: "no active sprint phase" },
        };
      }

      const completed = markPhaseComplete(ctx.cwd, sprintNumber, phaseId, params.summary);
      if (!completed) {
        return {
          content: [{ type: "text", text: `Error: phase ${phaseId} not found in sprint ${sprintNumber}.` }],
          details: { error: "phase not found" },
        };
      }

      const next = nextIncompletePhase(ctx.cwd, sprintNumber);
      if (!next) {
        controller.state.sprintLoop = undefined;
        controller.state.clearTodos();
        controller.state.setMode("auto");
        controller.applyMode(ctx);
        controller.persist();
        return {
          content: [{ type: "text", text: `Sprint ${sprintNumber} is complete.` }],
          details: { sprintNumber, completedPhaseId: phaseId, nextPhaseId: null },
          terminate: true,
        };
      }

      controller.state.sprintLoop = {
        sprintNumber,
        currentPhaseId: phaseId,
        pendingNextPhaseId: next.id,
      };
      controller.state.clearTodos();
      controller.state.setMode("sprint:plan");
      controller.applyMode(ctx);
      controller.persist();
      return {
        content: [
          {
            type: "text",
            text: `Phase ${phaseId} complete. Moonpi will compact context and continue with phase ${next.id}.`,
          },
        ],
        details: { sprintNumber, completedPhaseId: phaseId, nextPhaseId: next.id },
        terminate: true,
      };
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    const loop = controller.state.sprintLoop;
    if (!loop?.pendingNextPhaseId) return;
    const phase = phaseById(ctx.cwd, loop.sprintNumber, loop.pendingNextPhaseId);
    if (!phase) {
      controller.state.sprintLoop = undefined;
      controller.applyMode(ctx);
      controller.persist();
      ctx.ui.notify(`Pending phase ${loop.pendingNextPhaseId} was not found. Sprint loop stopped.`, "error");
      return;
    }

    controller.state.sprintLoop = {
      sprintNumber: loop.sprintNumber,
      currentPhaseId: phase.id,
    };
    controller.state.setMode("sprint:plan");
    controller.applyMode(ctx);
    controller.persist();
    continueAfterCompaction(pi, ctx, buildPhaseInstruction(loop.sprintNumber, phase));
  });
}
