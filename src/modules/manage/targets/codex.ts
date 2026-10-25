import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findExecutable } from "@/_libs";
import type { ConfigTarget, ConfigWriteResult, McpServerEntry } from "@/_types";

import { updateConfigFile } from "./config-file";
import { hasMcpServerToml, parseMcpServersToml, writeMcpServerToml } from "./toml-subset";



/**
 * Codex CLI. Its config is TOML, edited here by rewriting just the `[mcp_servers.<name>]`
 * span of the text — the rest of the file, Codex's model and approval settings included,
 * is never re-serialized.
 */
export function createCodexTarget(): ConfigTarget {
    const CODEX_CONFIG_PATH = path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex"), "config.toml");
    function readText(): string {
        if (fs.existsSync(CODEX_CONFIG_PATH) == false) {
            return "";
        }

        return fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
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

        hasEntry(name: string): boolean {
            return hasMcpServerToml(readText(), name);
        },

        writeEntry(name: string, entry: McpServerEntry, options?: { replace?: boolean }): ConfigWriteResult {
            updateConfigFile(CODEX_CONFIG_PATH, (original) => {
                let text = original;
                if (options?.replace) {
                    text = writeMcpServerToml(text, name, null);
                }
                return writeMcpServerToml(text, name, entry);
            });
            return { status: "written", detail: CODEX_CONFIG_PATH };
        },

        removeEntry(name: string): ConfigWriteResult {
            updateConfigFile(CODEX_CONFIG_PATH, (text) => writeMcpServerToml(text, name, null));
            return { status: "written", detail: CODEX_CONFIG_PATH };
        },
    };
}
