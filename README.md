# tmux-spawn

Pi extension that adds `/spawn` to open a subagent in a new tmux pane.

Reference example: `/Users/bytedance/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`

Relevant docs: `/Users/bytedance/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## Usage

```text
/spawn bob to build auth module
/spawn an agent that says hi
/spawn bob
/spawn
```

The command parses the input into an agent name and task, creates a temporary Pi config, injects a `spawn-signal.ts` extension, then starts Pi in a tmux split.

## Spawned-agent name bar

Each spawned Pi receives `PI_SPAWN_AGENT_NAME` and the injected extension draws a one-line top header with `ctx.ui.setHeader()`, e.g. `╭─ bob ─╮`. This is rendered by Pi's TUI framework, not by tmux. The tmux pane title is still set to the same name as a fallback.

The temp config also gets copies of `fd`/`rg` in `bin/` when available so Pi does not print tool-download messages above the name bar on startup.

## Blocking / completion notification

The parent command blocks only when a task is supplied. It uses tmux `wait-for` lock mode:

1. parent locks `pi-spawn-idle-*` before spawning the pane;
2. subagent runs the initial task;
3. injected extension handles `agent_end` and unlocks/signals the tmux channel;
4. parent unblocks and shows `Agent "name" finished`.

Important implementation notes:

- use `tmux wait-for -L` for both the pre-lock and the parent wait;
- use `tmux wait-for -U` in the subagent to release the lock;
- the extension also sends `-S` as a compatibility signal;
- inject the signal extension by absolute path, not cwd-relative `extensions/spawn-signal.ts`.

## Files

- `index.ts` - extension implementation
- `CHECKPOINT.md` - project checkpoint and design notes
