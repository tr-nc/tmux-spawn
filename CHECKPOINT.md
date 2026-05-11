# tmux-spawn

Pi extension that spawns subagents into tmux panes. Natural language command parsing via LLM, named agents, context injection, and idle detection.

## How it works

```
/spawn bob to build auth module
        ↓
  parseWithLLM() — calls pi -p with a system prompt
  extracts { name: "bob", task: "build auth module" }
        ↓
  creates a temp pi config dir with:
  - copied settings.json + auth.json (credentials, model prefs)
  - quietStartup: true (no banner)
  - extensions/spawn-signal.ts (idle detector)
        ↓
  spawns tmux pane running pi interactively:
  PI_CODING_AGENT_DIR=/tmp/... pi --model deepseek/deepseek-v4-flash 'task'
  pane title set to agent name via tmux select-pane -T
        ↓
  main agent blocks on tmux wait-for (locked before spawn)
        ↓
  subagent processes task, becomes idle
  spawn-signal.ts fires on agent_end → tmux wait-for -U
        ↓
  main agent unblocks → "Agent bob finished"
```

## Usage

| Command | Result |
|---------|--------|
| `/spawn` | Idle agent with auto-generated name |
| `/spawn bob` | Idle agent named "bob" |
| `/spawn bob to do X` | Agent "bob" assigned "do X" |
| `/spawn an agent that says hi` | Auto-name, task: "Say hi" |

## Key design decisions

- **LLM parsing**: natural language commands are parsed by a cheap LLM (deepseek-v4-flash, thinking off). Falls back to first-word-as-name if LLM fails.
- **Interactive mode**: subagents run in interactive pi (visible TUI), not RPC or print mode. They stay alive after the task.
- **Idle detection**: a small extension (`spawn-signal.ts`) is injected into each subagent's config. It listens for `agent_end` and signals the main agent via `tmux wait-for`. Signals once to avoid errors on subsequent turns.
- **Config isolation**: each subagent gets a temp config dir at `/tmp/pi-spawn-config-TIMESTAMP/` with `quietStartup: true` and the parent's credentials copied.
- **PATH resolution**: resolves absolute paths for pi, node, and cargo bin dirs since tmux spawns a non-interactive shell that skips rc files.
- **Context injection**: parent session path, cwd, and agent name are prepended to the subagent's initial prompt.

## File structure

```
index.ts          — the pi extension
CHECKPOINT.md     — this file
```

## Dependencies

- tmux
- pi (global): binary at `which pi`
- node (global): binary at `which node`
- fd (global): installed via `cargo install fd-find`, avoids auto-download in each subagent
- deepseek-v4-flash: used for both LLM parsing and spawned agents

## Todos

- [ ] Subagent termination / self-close detection
- [ ] Main bot announces subagent results (not just "finished")
- [ ] Timeout for stuck subagents
- [ ] Per-subagent session tracking (link sessions)
