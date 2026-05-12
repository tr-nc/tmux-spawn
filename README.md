# tmux-spawn

Pi extension that adds `/spawn` to open a subagent in a new tmux pane.

Reference example: `/Users/bytedance/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`

Relevant docs: `/Users/bytedance/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## Usage

Slash command usage is still supported:

```text
/spawn bob to build auth module
/spawn an agent that says hi
/spawn bob
/spawn
```

Plain text delegation is also supported through the main agent's `spawn_agent` tool. Spawn keywords include `spawn`, `hire`, `create an agent`, `make an agent`, `start`, `launch`, and `add`:

```text
spawn a agent named bob
hire bob to review the diff
create an agent named alice
spawn bob and ask about his model
```

The command/tool path parses the input into an agent name and task, creates a temporary Pi config, injects a `spawn-signal.ts` extension, then starts Pi in a tmux split.

## Spawned-agent name bar

Each spawned Pi receives `PI_SPAWN_AGENT_NAME` and the injected extension draws a one-line top header with `ctx.ui.setHeader()`, e.g. `> bob`. This is rendered by Pi's TUI framework, not by tmux. The tmux pane title is still set to the same name as a fallback.

The temp config also gets copies of `fd`/`rg` in `bin/` when available so Pi does not print tool-download messages above the name bar on startup.

## Continuing spawned agents

Spawned agents are tracked by name and pane id in the main extension runtime.

- `/agents` lists known spawned agents.
- `/tell bob to say hi` sends a follow-up prompt to bob's existing Pi pane/session.
- `/kill-agent bob` kills bob's tmux pane and removes it from tracking. Kill keywords include `despawn`, `kill`, `fire`, `nuke`, `stop`, `close`, `terminate`, and `remove`.
- Agent names are unique. If a requested name already exists, the new agent gets a similar fallback such as `bob-2`.
- Natural input like `tell bob to say hi again` is intercepted and sent directly to bob.
- The main agent also gets spawned-agent context in its system prompt and can use the `list_spawned_agents`, `tell_spawned_agent`, `spawn_agent`, `wait_for_spawned_agent`, `collect_spawned_reports`, and `kill_spawned_agent` tools when useful.
- If the main agent no longer needs a subagent, it can call `kill_spawned_agent` on its own.
- When the main agent quits normally, all tracked spawned-agent panes are killed as well.
- Pane layout is stable and serialized: the main agent keeps about 60% of the window, spawned agents share the remaining 40%.
- Additional spawned agents split inside the existing spawned-agent area, using tmux pane metadata to discover the current layout instead of relying on in-memory ordering.

## Reports back to the main agent

Spawned agents get an injected `report_to_parent` tool. When the main agent uses `spawn_agent` or `tell_spawned_agent`, it can choose `reportKeys` (for example `["status", "summary", "files"]`). The subagent is instructed to call `report_to_parent` with a JSON object using those keys.

By default, `spawn_agent`/`tell_spawned_agent` block when a task is supplied and return the report immediately. For independent work, the main agent can set `wait=false`; the subagent runs in the background, and the main agent can later call `wait_for_spawned_agent` to join or `collect_spawned_reports` to read already-written reports without blocking.

If the subagent does not call `report_to_parent`, the injected extension also tries to parse JSON from the subagent's final assistant message.

## Blocking / background work / completion notification

The extension supports both blocking and background delegation:

- default `wait=true`: parent locks the agent channel, sends/spawns the task, waits for `agent_end`, then returns reports;
- `wait=false`: parent locks the channel, sends/spawns the task, returns immediately, and records the task as `[running]`;
- `wait_for_spawned_agent`: joins a recorded background task and returns reports;
- `collect_spawned_reports`: reads reports that already exist without waiting.

It uses tmux `wait-for` lock mode:

1. parent locks `pi-spawn-idle-*` before spawning/sending a task;
2. subagent runs the task;
3. injected extension handles `agent_end` and unlocks/signals the tmux channel;
4. parent either unblocks immediately (`wait=true`) or can join later (`wait=false`).

Important implementation notes:

- use `tmux wait-for -L` for both the pre-lock and the parent wait;
- use `tmux wait-for -U` in the subagent to release the lock;
- the extension also sends `-S` as a compatibility signal;
- inject the signal extension by absolute path, not cwd-relative `extensions/spawn-signal.ts`.

## Files

- `index.ts` - extension implementation
- `CHECKPOINT.md` - project checkpoint and design notes
