import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findExecutable } from "@/_libs";
import type { ConfigTarget, ConfigWriteResult, McpServerEntry } from "@/_types";

import { parseMcpServersToml, writeMcpServerToml } from "./toml-subset";

const CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");

/**
 * Codex CLI. Its config is TOML, edited here by rewriting just the `[mcp_servers.<name>]`
 * span of the text — the rest of the file, Codex's model and approval settings included,
 * is never re-serialized.
 */
export function createCodexTarget(): ConfigTarget {
    function readText(): string {
        if (fs.existsSync(CODEX_CONFIG_PATH) == false) {
            return "";
        }

        return fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    }

    function writeText(text: string): ConfigWriteResult {
        fs.mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CODEX_CONFIG_PATH, text, "utf8");
        return { status: "written", detail: CODEX_CONFIG_PATH };
    }

    return {
        id: "codex",
        label: "Codex CLI",
        location: CODEX_CONFIG_PATH,
        detected: findExecutable("codex") != null || fs.existsSync(CODEX_CONFIG_PATH) == true,

        readEntries(): Record<string, McpServerEntry> {
            const text = readText();
            return parseMcpServersToml(text);
        },

        writeEntry(name: string, entry: McpServerEntry): ConfigWriteResult {
            const text = readText();
            const updated = writeMcpServerToml(text, name, entry);
            return writeText(updated);
        },

        removeEntry(name: string): ConfigWriteResult {
            const text = readText();
            const updated = writeMcpServerToml(text, name, null);
            return writeText(updated);
        },
    };
}
