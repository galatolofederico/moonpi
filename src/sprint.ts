import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

function nextSprintNumber(cwd: string): number {
  const dir = sprintsDir(cwd);
  if (!existsSync(dir)) return 1;
  const numbers = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number.parseInt(entry.name, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

function writeSprintFiles(
  cwd: string,
  project: string,
  outcome: string,
  constraints: string,
  verification: string,
): number {
  const sprintNumber = nextSprintNumber(cwd);
  const dir = sprintDir(cwd, sprintNumber);
  mkdirSync(dir, { recursive: true });

  const sprint = `# Sprint ${sprintNumber}: ${project}

## Goal

${outcome}

## Constraints, Risks, and Dependencies

${constraints || "No additional constraints provided."}

## Definition of Done

- The implementation satisfies the goal above.
- Every phase in TASKS.md is complete.
- Verification tasks listed in TASKS.md have been run or explicitly documented with a reason.
- README.md and SPECS.md are updated when behavior, setup, commands, or architecture changed.

## Required Verification

${verification || "Run the most relevant package checks and focused tests for the changed area."}
`;

  const tasks = `# Tasks for Sprint ${sprintNumber}

Project: ${project}

## Phase 1: Discovery and scope
<!-- moonpi-phase:1 -->
- [ ] P1.T1 Identify affected packages, files, commands, and user-visible workflows.
- [ ] P1.T2 Read relevant README.md, SPECS.md, and local project instructions.
- [ ] P1.T3 Record implementation risks and unresolved questions.
- [ ] P1.V1 Verification: confirm the target files and commands needed for later phases are known.

## Phase 2: Design and plan
<!-- moonpi-phase:2 -->
- [ ] P2.T1 Convert the sprint goal into concrete implementation steps.
- [ ] P2.T2 Define acceptance criteria for each changed workflow.
- [ ] P2.T3 Identify the focused tests or checks that prove the phase is complete.
- [ ] P2.V1 Verification: the plan can be executed without needing new high-level decisions.

## Phase 3: Implementation
<!-- moonpi-phase:3 -->
- [ ] P3.T1 Implement the planned changes in the smallest coherent slices.
- [ ] P3.T2 Update TODO status as each material task changes.
- [ ] P3.T3 Keep README.md and SPECS.md current if behavior or setup changes.
- [ ] P3.V1 Verification: changed code is internally consistent and ready for focused validation.

## Phase 4: Validation
<!-- moonpi-phase:4 -->
- [ ] P4.T1 Run the focused checks or tests identified earlier.
- [ ] P4.T2 Fix every failure, warning, or info item that applies to the sprint.
- [ ] P4.T3 Document any verification that could not be run and why.
- [ ] P4.V1 Verification: the sprint can be reviewed with clear evidence.

## Phase 5: Final review
<!-- moonpi-phase:5 -->
- [ ] P5.T1 Review changed files for scope, regressions, and missing documentation.
- [ ] P5.T2 Summarize completed work and remaining risk.
- [ ] P5.V1 Verification: TASKS.md shows every phase complete.
`;

  writeFileSync(sprintPath(cwd, sprintNumber), sprint, "utf-8");
  writeFileSync(tasksPath(cwd, sprintNumber), tasks, "utf-8");
  return sprintNumber;
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
    const match = /^## Phase\s+([^:]+):\s*(.+)$/.exec(lines[index] ?? "");
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

async function askRequired(ctx: ExtensionCommandContext, title: string, prefill: string): Promise<string | undefined> {
  const answer = await ctx.ui.editor(title, prefill);
  return answer?.trim();
}

function parseSprintNumber(raw: string): number | undefined {
  const number = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function continueAfterCompaction(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
  ctx.compact({
    customInstructions: "Moonpi sprint loop completed one phase. Preserve the sprint goal, completed phase summary, and next phase instructions.",
    onComplete: () => pi.sendUserMessage(prompt),
    onError: () => pi.sendUserMessage(prompt),
  });
}

export function installSprintWorkflow(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.registerCommand("sprint:create", {
    description: "Create a moonpi sprint under ./sprints/<number>",
    handler: async (args, ctx) => {
      const project = args.trim();
      if (!project) {
        ctx.ui.notify("Usage: /sprint:create <big project>", "error");
        return;
      }

      const outcome = await askRequired(ctx, "Sprint outcome", project);
      if (!outcome) return;
      const constraints = await askRequired(ctx, "Constraints, risks, dependencies", "");
      if (constraints === undefined) return;
      const verification = await askRequired(ctx, "Required verification", "");
      if (verification === undefined) return;

      const sprintNumber = writeSprintFiles(ctx.cwd, project, outcome, constraints, verification);
      ctx.ui.notify(`Created sprint ${sprintNumber} in ./sprints/${sprintNumber}`, "info");
    },
  });

  pi.registerCommand("sprint:loop", {
    description: "Execute the next incomplete phase in ./sprints/<number>/TASKS.md",
    handler: async (args, ctx) => {
      const sprintNumber = parseSprintNumber(args);
      if (!sprintNumber) {
        ctx.ui.notify("Usage: /sprint:loop <sprint_number>", "error");
        return;
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
      controller.state.setMode("act");
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
    controller.applyMode(ctx);
    controller.persist();
    continueAfterCompaction(pi, ctx, buildPhaseInstruction(loop.sprintNumber, phase));
  });
}
