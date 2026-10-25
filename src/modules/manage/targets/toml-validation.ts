import { isDeepStrictEqual } from "node:util";
import { parse, TomlError } from "smol-toml";
import type { McpServerEntry } from "@/_types";
import { readMcpServersJson } from "./json-file";

type Document = Record<string, unknown>;

function isTable(value: unknown): value is Document {
    return value != null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/** Parse the whole document; error messages must not echo credential-bearing source lines. */
export function parseConfigToml(text: string): Document {
    let document: Document;
    try {
        document = parse(text, { integersAsBigInt: true });
    }
    catch (error) {
        const location = error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : "";
        throw new Error(`Invalid TOML${location}; fix the config before changing it.`);
    }
    if (Object.hasOwn(document, "mcp_servers") && !isTable(document.mcp_servers)) {
        throw new Error("mcp_servers must be a TOML table.");
    }
    return document;
}

export function readTomlEntries(text: string): Record<string, McpServerEntry> {
    return readMcpServersJson({ mcpServers: parseConfigToml(text).mcp_servers ?? {} });
}

export function hasTomlEntry(text: string, name: string): boolean {
    return Object.hasOwn(parseConfigToml(text).mcp_servers ?? {}, name);
}

function normalize(document: Document): void {
    const servers = document.mcp_servers as Document | undefined;
    if (servers == null) {
        return;
    }
    for (const server of Object.values(servers)) {
        if (isTable(server) && isTable(server.env) && Object.keys(server.env).length === 0) {
            delete server.env;
        }
    }
    if (Object.keys(servers).length === 0) {
        delete document.mcp_servers;
    }
}

/** Refuse edits that change anything except the requested server's owned fields. */
export function verifyTomlEdit(before: string, after: string, name: string, entry: McpServerEntry | null): string {
    const expected = parseConfigToml(before);
    const servers = (expected.mcp_servers ?? Object.create(null)) as Document;
    if (entry == null) {
        delete servers[name];
    }
    else {
        const previous = Object.hasOwn(servers, name) && isTable(servers[name]) ? servers[name] as Document : {};
        Object.defineProperty(servers, name, {
            value: Object.assign(Object.create(null), previous, { command: entry.command, args: [...entry.args], env: Object.assign(Object.create(null), entry.env) }),
            configurable: true, enumerable: true, writable: true,
        });
    }
    expected.mcp_servers = servers;

    let actual: Document;
    try {
        actual = parseConfigToml(after);
    }
    catch {
        throw new Error("Cannot safely edit this TOML layout. Use [mcp_servers.<name>] tables; nothing was written.");
    }
    normalize(expected);
    normalize(actual);
    if (!isDeepStrictEqual(expected, actual)) {
        throw new Error("Cannot safely edit this TOML layout without changing other settings; nothing was written.");
    }
    return after;
}
