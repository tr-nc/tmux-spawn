import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spawn", {
    description: "Spawn a pi RPC instance in a tmux pane (below if tall, right if wide)",
    handler: async (args, ctx) => {
      const initialPrompt = args as string;

      // Get current tmux window dimensions in characters and cell pixel sizes
      const dims = await pi.exec("tmux", [
        "display-message",
        "-p",
        "#{window_height}:#{window_width}:#{window_cell_height}:#{window_cell_width}",
      ]);

      if (dims.code !== 0) {
        ctx.ui.notify("Not running inside tmux", "error");
        return;
      }

      const parts = dims.stdout.trim().split(":");
      const height = parseInt(parts[0], 10);
      const width = parseInt(parts[1], 10);
      const cellH = parseInt(parts[2], 10);
      const cellW = parseInt(parts[3], 10);

      if (isNaN(height) || isNaN(width) || isNaN(cellH) || isNaN(cellW)) {
        ctx.ui.notify("Failed to parse tmux window dimensions", "error");
        return;
      }

      // compare visual pixel dimensions, not raw char counts
      const pixelHeight = height * cellH;
      const pixelWidth = width * cellW;
      const splitArg = pixelHeight > pixelWidth ? "-v" : "-h";
      const direction = pixelHeight > pixelWidth ? "below" : "right";

      // build shell command that pipes the initial prompt to pi
      let shellCmd: string;
      if (initialPrompt) {
        const payload = JSON.stringify({
          type: "prompt",
          message: initialPrompt,
        });
        // write payload to a temp file, then pipe it to pi via cat.
        // cat reads the file first, then stdin (the terminal), keeping
        // pi's stdin open for future commands.
        const tmpFile = join(tmpdir(), `pi-spawn-${Date.now()}.json`);
        writeFileSync(tmpFile, payload + "\n");
        shellCmd = `cat ${tmpFile} - | pi --mode rpc --no-session; rm -f ${tmpFile}`;
      } else {
        shellCmd = "pi --mode rpc --no-session";
      }

      const result = await pi.exec("tmux", [
        "split-window",
        splitArg,
        shellCmd,
      ]);

      if (result.code !== 0) {
        ctx.ui.notify(
          `Failed to spawn pane: ${result.stderr || "unknown error"}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(`New pane spawned ${direction}`, "info");
    },
  });
}
