import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findExecutable } from "@/_libs";
import type { ConfigTarget, ConfigWriteResult, McpServerEntry } from "@/_types";

import { readMcpServersJson, readRawMcpServersJson } from "./json-file";

/** The user-scope file; `mcpServers` at its top level is what `claude mcp … -s user` edits. */
const CLAUDE_CODE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

/** Characters `cmd.exe` treats specially; each gets a `^` so it reaches the program literally. */
const CMD_META_CHARACTER_PATTERN = /([()\][%!^"`<>&|;, *?])/g;

/** The `claude mcp add-json` payload: the entry plus the transport it leaves implicit. */
export function toClaudeAddJsonPayload(entry: McpServerEntry): string {
    return JSON.stringify({ type: "stdio", command: entry.command, args: entry.args, env: entry.env });
}

/** The command line `add-json` is driven with — also what the print view hands the user to paste. */
export function formatClaudeAddCommand(name: string, entry: McpServerEntry): string {
    const payload = toClaudeAddJsonPayload(entry);
    return `claude mcp add-json ${name} '${payload}' -s user`;
}

/**
 * Quotes one argument for a `.cmd` shim: MSVCRT rules first (what the `node.exe` behind the
 * shim parses), then a `^` before every `cmd.exe` metacharacter — twice, because an npm shim
 * hands the line to `cmd.exe` once more. The same scheme cross-spawn uses.
 */
function escapeCmdArgument(argument: string): string {
    let escaped = argument.replace(/(\\*)"/g, "$1$1\\\"");
    escaped = escaped.replace(/(\\*)$/, "$1$1");
    escaped = `"${escaped}"`;
    escaped = escaped.replace(CMD_META_CHARACTER_PATTERN, "^$1");
    escaped = escaped.replace(CMD_META_CHARACTER_PATTERN, "^$1");
    return escaped;
}

/**
 * Runs a CLI and waits for it. A native executable is spawned directly; a `.cmd` / `.bat`
 * shim (npm's install on Windows) cannot be, so it goes through `cmd.exe` with every
 * argument escaped — the JSON payload is full of quotes that would otherwise be eaten.
 */
export function runCliCommand(executable: string, args: string[]): SpawnSyncReturns<string> {
    const isBatchShim = /\.(cmd|bat)$/i.test(executable) == true;
    if (process.platform !== "win32" || isBatchShim == false) {
        const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
        return result;
    }

    const commandLine = [executable.replace(CMD_META_CHARACTER_PATTERN, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: true,
    });
    return result;
}

function runClaude(executable: string, args: string[]): ConfigWriteResult {
    const result = runCliCommand(executable, args);

    if (result.error != null) {
        return { status: "unavailable", detail: `could not run claude: ${result.error.message}` };
    }

    if (result.status !== 0) {
        let output = (result.stderr ?? "").trim();
        if (output === "") {
            output = (result.stdout ?? "").trim();
        }
        return { status: "unavailable", detail: `claude exited with ${result.status}: ${output}` };
    }

    return { status: "written", detail: CLAUDE_CODE_CONFIG_PATH };
}

function readRawClaudeEntries(): Record<string, unknown> {
    if (fs.existsSync(CLAUDE_CODE_CONFIG_PATH) == false) {
        return {};
    }

    const text = fs.readFileSync(CLAUDE_CODE_CONFIG_PATH, "utf8");
    let document: unknown;
    try {
        document = JSON.parse(text);
    }
    catch (ex) {
        let detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
        throw new Error(`${CLAUDE_CODE_CONFIG_PATH} is not valid JSON: ${detail}`);
    }

    return readRawMcpServersJson(document);
}

/**
 * Claude Code, user scope. Read straight from `~/.claude.json`; written through the
 * `claude mcp` CLI, because that file is Claude Code's own state — large, rewritten by
 * the running process — and `mcpServers` is one key among many.
 */
export function createClaudeCodeTarget(): ConfigTarget {
    const executable = findExecutable("claude");

    return {
        id: "claude-code",
        label: "Claude Code (user scope)",
        location: CLAUDE_CODE_CONFIG_PATH,
        detected: executable != null || fs.existsSync(CLAUDE_CODE_CONFIG_PATH) == true,

        readEntries(): Record<string, McpServerEntry> {
            return readMcpServersJson({ mcpServers: readRawClaudeEntries() });
        },

        hasEntry(name: string): boolean {
            return Object.hasOwn(readRawClaudeEntries(), name);
        },

        writeEntry(name: string, entry: McpServerEntry): ConfigWriteResult {
            if (executable == null) {
                return {
                    status: "unavailable",
                    detail: "the claude CLI is not on PATH — install it, or use Print to get a command to run yourself",
                };
            }

            // `add-json` refuses a name that exists, so an edit is remove-then-add. If the add
            // then fails, the old entry goes back rather than leaving the host unregistered.
            const previousEntries = readRawClaudeEntries();
            const hadPrevious = Object.hasOwn(previousEntries, name);
            const previous = previousEntries[name];
            if (hadPrevious) {
                const removed = runClaude(executable, ["mcp", "remove", name, "-s", "user"]);
                if (removed.status === "unavailable") {
                    return removed;
                }
            }

            const added = runClaude(executable, ["mcp", "add-json", name, toClaudeAddJsonPayload(entry), "-s", "user"]);
            if (added.status === "unavailable" && hadPrevious) {
                const restored = runClaude(executable, ["mcp", "add-json", name, JSON.stringify(previous), "-s", "user"]);
                const recovery = restored.status === "written"
                    ? "the previous entry was restored"
                    : `could not restore the previous entry: ${restored.detail}`;
                return { status: "unavailable", detail: `${added.detail}\n  ${recovery}` };
            }

            return added;
        },

        removeEntry(name: string): ConfigWriteResult {
            if (executable == null) {
                return {
                    status: "unavailable",
                    detail: `the claude CLI is not on PATH — run this yourself:\n  claude mcp remove ${name} -s user`,
                };
            }

            return runClaude(executable, ["mcp", "remove", name, "-s", "user"]);
        },
    };
}
