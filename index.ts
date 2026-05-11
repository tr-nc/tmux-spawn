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

      const result = await pi.exec("tmux", [
        "split-window", "-P", "-F", "#{pane_id}",
        splitArg,
        "pi --mode rpc --no-session",
      ]);

      if (result.code !== 0) {
        ctx.ui.notify(
          `Failed to spawn pane: ${result.stderr || "unknown error"}`,
          "error",
        );
        return;
      }

      const paneId = result.stdout.trim();
      ctx.ui.notify(`New pane spawned ${direction}`, "info");

      if (initialPrompt) {
        // let pi start up before sending the initial prompt
        await new Promise((r) => setTimeout(r, 300));

        const payload = JSON.stringify({
          type: "prompt",
          message: initialPrompt,
        });
        await pi.exec("tmux", [
          "send-keys", "-l", "-t", paneId,
          payload, "Enter",
        ]);
      }
    },
  });
}
