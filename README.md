# moonpi

Moonpi is a pi package that adds Plan, Act, Auto, and Fast workflows for the pi coding agent.

Install from git:

```bash
pi install git:github.com/myname/moonpi@v1
```

Try from a local checkout:

```bash
pi -e ./moonpi
```

## Modes

- `auto`: default. Plan first, then act after `moonpi_todo` creates work items. The model can call `end_conversation` during planning when the user only asked a question.
- `plan`: read-only planning. Editing tools and bash are disabled. The model must create a TODO list.
- `act`: editing tools are enabled. TODO and Q&A tools are available.
- `fast`: editing tools are enabled. TODO and Q&A tools are disabled.

Cycle modes with Tab and Shift+Tab when the editor is empty. Use `/moonpi:mode <mode>` to switch directly.

## Configuration

Create `.pi/moonpi.json` in a project:

```json
{
  "contextFiles": {
    "enabled": true
  },
  "keybindings": {
    "cycleNext": "tab",
    "cyclePrevious": "shift+tab"
  }
}
```

Use `/moonpi:settings` to view the effective settings.

## Sprint Commands

- `/sprint:create <project>` asks clarifying questions and creates `SPRINT.md` and `TASKS.md` under `./sprints/<number>`.
- `/sprint:loop <number>` starts the next incomplete phase. The model ends a phase by calling `end_phase`, then moonpi updates `TASKS.md`, compacts context, and continues.
