import fs from "node:fs";
import path from "node:path";

import type { ConfigTarget, ConfigTargetId, McpServerEntry } from "@/_types";

/** Shape-checks one `mcpServers` value; anything without a string `command` is not an entry. */
export function toMcpServerEntry(value: unknown): McpServerEntry | null {
    if (typeof value !== "object" || value == null) {
        return null;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.command !== "string") {
        return null;
    }

    let args: string[] = [];
    if (Array.isArray(record.args) == true) {
        args = (record.args as unknown[]).filter((item): item is string => typeof item === "string");
    }

    const env: Record<string, string> = {};
    if (typeof record.env === "object" && record.env != null) {
        for (const [key, item] of Object.entries(record.env as Record<string, unknown>)) {
            if (typeof item === "string") {
                env[key] = item;
            }
        }
    }

    return { command: record.command, args: args, env: env };
}

/**
 * Reads the `mcpServers` map out of a parsed JSON document.
 *
 * @throws {Error} If the document is not an object.
 */
export function readMcpServersJson(document: unknown): Record<string, McpServerEntry> {
    if (typeof document !== "object" || document == null || Array.isArray(document) == true) {
        throw new Error("the config file is not a JSON object");
    }

    const entries: Record<string, McpServerEntry> = {};
    const servers = (document as Record<string, unknown>).mcpServers;
    if (typeof servers !== "object" || servers == null) {
        return entries;
    }

    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
        const entry = toMcpServerEntry(value);
        if (entry != null) {
            entries[name] = entry;
        }
    }

    return entries;
}

/**
 * Parses a `mcpServers` JSON file, or returns an empty document when it does not exist.
 *
 * @throws {Error} If the file exists but is not valid JSON — it is never written over.
 */
function readDocument(filePath: string): Record<string, unknown> {
    if (fs.existsSync(filePath) == false) {
        return {};
    }

    const text = fs.readFileSync(filePath, "utf8");
    if (text.trim() === "") {
        return {};
    }

    let document: unknown;
    try {
        document = JSON.parse(text);
    }
    catch (ex) {
        let detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
        throw new Error(`${filePath} is not valid JSON: ${detail}`);
    }

    if (typeof document !== "object" || document == null || Array.isArray(document) == true) {
        throw new Error(`${filePath} is not a JSON object`);
    }

    return document as Record<string, unknown>;
}

/**
 * A client whose config is a plain JSON file with a `mcpServers` map and nothing that
 * fights over it — Claude Desktop, Cursor. Written as read → set one key → write, so
 * every other key in the file survives untouched.
 */
export function createJsonFileTarget(options: {
    id: ConfigTargetId;
    label: string;
    filePath: string;
}): ConfigTarget {
    const { id, label, filePath } = options;

    function writeDocument(document: Record<string, unknown>): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(document, null, 4)}\n`, "utf8");
    }

    return {
        id: id,
        label: label,
        location: filePath,
        detected: fs.existsSync(filePath),

        readEntries(): Record<string, McpServerEntry> {
            const document = readDocument(filePath);
            return readMcpServersJson(document);
        },

        writeEntry(name: string, entry: McpServerEntry) {
            const document = readDocument(filePath);

            let servers = document.mcpServers;
            if (typeof servers !== "object" || servers == null || Array.isArray(servers) == true) {
                servers = {};
            }

            (servers as Record<string, unknown>)[name] = entry;
            document.mcpServers = servers;
            writeDocument(document);

            return { status: "written" as const, detail: filePath };
        },

        removeEntry(name: string) {
            const document = readDocument(filePath);

            const servers = document.mcpServers;
            if (typeof servers !== "object" || servers == null || Array.isArray(servers) == true) {
                return { status: "written" as const, detail: filePath };
            }

            delete (servers as Record<string, unknown>)[name];
            writeDocument(document);

            return { status: "written" as const, detail: filePath };
        },
    };
}
