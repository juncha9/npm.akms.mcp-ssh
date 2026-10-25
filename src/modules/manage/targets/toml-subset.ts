import { lineState, scanTomlLine } from "./toml-lines";
import type { McpServerEntry } from "@/_types";
import { hasTomlEntry, parseConfigToml, readTomlEntries, verifyTomlEdit } from "./toml-validation";

/**
 * The slice of TOML Codex's `[mcp_servers.*]` tables use: string / string-array / inline
 * table values, plus `[mcp_servers.<name>.env]` sub-tables. The file is handled as a list of
 * sections (a header line and the lines under it); only the sections of the server being
 * written are rebuilt, and unrelated text is preserved. A complete TOML parser validates
 * input and output and verifies that no unrelated setting changed.
 */

const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const ANY_HEADER_PATTERN = /^\s*\[/;
const SERVER_HEADER_PATTERN = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*((?:\.[^\]]*)?)\]\s*(?:#.*)?$/;
const KEY_VALUE_PATTERN = /^\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*=\s*(.*)$/;

/** Keys of the server table this package owns; any other key in it is the user's and is kept. */
const OWNED_TABLE_KEYS = ["command", "args", "env"];

interface TomlSection {
    /** Null for the lines before the first header. */
    header: string | null;
    /** Set when the header is `[mcp_servers.<name>…]`. */
    serverName: string | null;
    /** What follows the server name: "" for the server table, "env" for its env table. */
    subPath: string;
    body: string[];
}

interface TomlStatement {
    key: string;
    /** Line range inside the section body, end exclusive. */
    start: number;
    end: number;
}

function unquoteKey(rawKey: string): string {
    if (rawKey.startsWith("\"") || rawKey.startsWith("'")) {
        return parseConfigToml(`value = ${rawKey}`).value as string;
    }
    return rawKey;
}

/**
 * Key/value statements of one section body, a multi-line value spanning its lines. Also
 * what tells a `[` that opens a header apart from one inside a multi-line array.
 */
function readStatements(body: string[]): TomlStatement[] {
    const statements: TomlStatement[] = [];

    let index = 0;
    while (index < body.length) {
        const match = KEY_VALUE_PATTERN.exec(body[index]);
        if (match == null) {
            index += 1;
            continue;
        }

        const start = index;
        const state = lineState();
        scanTomlLine(match[2], state);
        index += 1;
        while ((state.quote != null || state.depth > 0) && index < body.length) {
            scanTomlLine(body[index], state);
            index += 1;
        }
        statements.push({ key: unquoteKey(match[1]), start: start, end: index });
    }

    return statements;
}

function splitSections(lines: string[]): TomlSection[] {
    const sections: TomlSection[] = [{ header: null, serverName: null, subPath: "", body: [] }];
    const state = lineState();

    for (const line of lines) {
        const current = sections[sections.length - 1];

        if (state.quote != null || state.depth > 0) {
            current.body.push(line);
            scanTomlLine(line, state);
            continue;
        }

        if (ANY_HEADER_PATTERN.test(line) == true) {
            const serverMatch = SERVER_HEADER_PATTERN.exec(line);
            let serverName: string | null = null;
            let subPath = "";
            if (serverMatch != null) {
                serverName = unquoteKey(serverMatch[1]);
                subPath = serverMatch[2].replace(/^\./, "").replace(/\s+/g, "");
            }

            sections.push({ header: line, serverName: serverName, subPath: subPath, body: [] });
            continue;
        }

        current.body.push(line);

        scanTomlLine(line, state);
    }

    return sections;
}

/** Includes HTTP servers and subtables even when no command can be parsed. */
export function hasMcpServerToml(text: string, name: string): boolean {
    return hasTomlEntry(text, name);
}

/**
 * Every `[mcp_servers.<name>]` table with a string `command`. A value this subset does not
 * read is skipped, not fatal — the file may hold servers this package never wrote.
 */
export function parseMcpServersToml(text: string): Record<string, McpServerEntry> {
    return readTomlEntries(text);
}

function quoteTomlString(value: string): string {
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

    return `"${escaped}"`;
}

function formatTomlKey(key: string): string {
    if (BARE_KEY_PATTERN.test(key) == true) {
        return key;
    }

    return quoteTomlString(key);
}

function renderOwnedLines(entry: McpServerEntry): string[] {
    return [
        `command = ${quoteTomlString(entry.command)}`,
        `args = [${entry.args.map((argument) => quoteTomlString(argument)).join(", ")}]`,
    ];
}

function renderEnvLines(entry: McpServerEntry): string[] {
    return Object.entries(entry.env).map(([key, value]) => `${formatTomlKey(key)} = ${quoteTomlString(value)}`);
}

/**
 * Renders one server as a table plus an `env` sub-table — one variable per line, so the
 * entry reads like a connection form, the same way the JSON clients' `env` block does.
 */
export function renderMcpServerTable(name: string, entry: McpServerEntry): string {
    const tableKey = formatTomlKey(name);
    const lines = [`[mcp_servers.${tableKey}]`, ...renderOwnedLines(entry)];

    const envLines = renderEnvLines(entry);
    if (envLines.length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${tableKey}.env]`);
        lines.push(...envLines);
    }

    return `${lines.join("\n")}\n`;
}

function isBlank(line: string): boolean {
    return line.trim() === "";
}

function joinSections(sections: TomlSection[], eol: string): string {
    const lines: string[] = [];
    for (const section of sections) {
        if (section.header != null) {
            lines.push(section.header);
        }
        lines.push(...section.body);
    }

    return lines.join(eol);
}

/**
 * Writes `entry` as the `[mcp_servers.<name>]` server, or removes the server when `entry`
 * is null.
 *
 * Replacing keeps what the user added by hand: keys of the server table other than
 * `command` / `args` / `env` (a `startup_timeout_sec`, say) and sub-tables other than
 * `env` stay where they are. Only `command`, `args` and the env table are rebuilt.
 */
export function writeMcpServerToml(text: string, name: string, entry: McpServerEntry | null): string {
    parseConfigToml(text);
    const updated = editMcpServerToml(text, name, entry);
    return verifyTomlEdit(text, updated, name, entry);
}

function editMcpServerToml(text: string, name: string, entry: McpServerEntry | null): string {
    let eol = "\n";
    if (text.includes("\r\n") == true) {
        eol = "\r\n";
    }

    const sections = splitSections(text.split(/\r?\n/));
    const isOwn = (section: TomlSection): boolean => section.serverName === name;

    if (entry == null) {
        const kept = sections.filter((section) => isOwn(section) == false);
        const removedText = joinSections(kept, eol);
        return removedText;
    }

    const tableKey = formatTomlKey(name);
    const envLines = renderEnvLines(entry);
    const tableIndex = sections.findIndex((section) => isOwn(section) == true && section.subPath === "");

    // (1) No table yet — append a fresh block after one blank line.
    if (tableIndex < 0) {
        const withoutStrayEnv = sections.filter((section) => (isOwn(section) == true && section.subPath === "env") == false);
        let prefix = joinSections(withoutStrayEnv, eol);

        if (prefix.trim() === "") {
            prefix = "";
        }
        else {
            prefix = prefix.replace(/(\r?\n)*$/, "");
            prefix = `${prefix}${eol}${eol}`;
        }

        const block = renderMcpServerTable(name, entry).replace(/\n/g, eol);
        return `${prefix}${block}`;
    }

    // (2) Rebuild the table body: owned keys first, then the user's own lines as they were.
    const table = sections[tableIndex];
    const ownedLineIndexes = new Set<number>();
    for (const statement of readStatements(table.body)) {
        if (OWNED_TABLE_KEYS.includes(statement.key) == true) {
            for (let index = statement.start; index < statement.end; index += 1) {
                ownedLineIndexes.add(index);
            }
        }
    }

    const userLines = table.body.filter((_line, index) => ownedLineIndexes.has(index) == false);

    // The blank lines closing the table are the gap before the next header; they move to
    // the end of whichever section now comes last.
    let trailingBlankCount = 0;
    while (trailingBlankCount < userLines.length && isBlank(userLines[userLines.length - 1 - trailingBlankCount]) == true) {
        trailingBlankCount += 1;
    }
    const trailingBlanks = userLines.slice(userLines.length - trailingBlankCount);
    const userContent = userLines.slice(0, userLines.length - trailingBlankCount);

    const rebuilt: TomlSection[] = [];
    for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];

        if (isOwn(section) == true && section.subPath === "env") {
            continue;
        }

        if (index !== tableIndex) {
            rebuilt.push(section);
            continue;
        }

        if (envLines.length === 0) {
            rebuilt.push({ ...section, body: [...renderOwnedLines(entry), ...userContent, ...trailingBlanks] });
            continue;
        }

        rebuilt.push({ ...section, body: [...renderOwnedLines(entry), ...userContent, ""] });
        rebuilt.push({
            header: `[mcp_servers.${tableKey}.env]`,
            serverName: name,
            subPath: "env",
            body: [...envLines, ...trailingBlanks],
        });
    }

    const rebuiltText = joinSections(rebuilt, eol);
    return rebuiltText;
}
