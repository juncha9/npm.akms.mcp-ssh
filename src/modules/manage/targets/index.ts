import os from "node:os";
import path from "node:path";

import type { ConfigTarget } from "@/_types";

import { createClaudeCodeTarget } from "./claude-code";
import { createCodexTarget } from "./codex";
import { createJsonFileTarget } from "./json-file";

export { formatClaudeAddCommand } from "./claude-code";
export { renderMcpServerTable } from "./toml-subset";

function claudeDesktopConfigPath(): string {
    if (process.platform === "win32") {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
        return path.join(appData, "Claude", "claude_desktop_config.json");
    }

    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }

    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Every supported client, detected ones first so the first entry is the sensible default. */
export function listConfigTargets(): ConfigTarget[] {
    const targets: ConfigTarget[] = [
        createClaudeCodeTarget(),
        createCodexTarget(),
        createJsonFileTarget({ id: "claude-desktop", label: "Claude Desktop", filePath: claudeDesktopConfigPath() }),
        createJsonFileTarget({ id: "cursor", label: "Cursor", filePath: path.join(os.homedir(), ".cursor", "mcp.json") }),
    ];

    const detected = targets.filter((target) => target.detected == true);
    const others = targets.filter((target) => target.detected == false);
    return [...detected, ...others];
}
