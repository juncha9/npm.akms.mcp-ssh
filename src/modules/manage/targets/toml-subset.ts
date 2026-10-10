import type { McpServerEntry } from "@/_types";

/**
 * The slice of TOML Codex's `[mcp_servers.*]` tables use: string / string-array / inline
 * table values, plus `[mcp_servers.<name>.env]` sub-tables. The file is handled as a list of
 * sections (a header line and the lines under it); only the sections of the server being
 * written are rebuilt, and every other line is returned byte for byte. Multi-line strings
 * (`"""`) are not read — no MCP entry this package writes uses them.
 */

const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const ANY_HEADER_PATTERN = /^\s*\[/;
const SERVER_HEADER_PATTERN = /^\s*\[\s*mcp_servers\s*\.\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*((?:\.[^\]]*)?)\]\s*(?:#.*)?$/;
const KEY_VALUE_PATTERN = /^\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*(.*)$/;

/** Keys of the server table this package owns; any other key in it is the user's and is kept. */
const OWNED_TABLE_KEYS = ["command", "args", "env"];

type TomlValue = string | TomlValue[] | { [key: string]: TomlValue };

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
    rawValue: string;
    /** Line range inside the section body, end exclusive. */
    start: number;
    end: number;
}

class TomlValueParser {
    private position = 0;

    constructor(private readonly text: string) {}

    parse(): TomlValue {
        const value = this.parseValue();
        return value;
    }

    private skipWhitespace(): void {
        while (this.position < this.text.length && /\s/.test(this.text[this.position]) == true) {
            this.position += 1;
        }
    }

    private parseValue(): TomlValue {
        this.skipWhitespace();
        const current = this.text[this.position];

        if (current === "\"") {
            return this.parseBasicString();
        }

        if (current === "'") {
            return this.parseLiteralString();
        }

        if (current === "[") {
            return this.parseArray();
        }

        if (current === "{") {
            return this.parseInlineTable();
        }

        throw new Error(`unsupported toml value at offset ${this.position}`);
    }

    private parseBasicString(): string {
        this.position += 1;
        let result = "";

        while (this.position < this.text.length) {
            const current = this.text[this.position];
            if (current === "\"") {
                this.position += 1;
                return result;
            }

            if (current !== "\\") {
                result += current;
                this.position += 1;
                continue;
            }

            const escaped = this.text[this.position + 1];
            this.position += 2;

            if (escaped === "n") {
                result += "\n";
            }
            else if (escaped === "t") {
                result += "\t";
            }
            else if (escaped === "r") {
                result += "\r";
            }
            else if (escaped === "u" || escaped === "U") {
                let length = 4;
                if (escaped === "U") {
                    length = 8;
                }
                const hex = this.text.slice(this.position, this.position + length);
                result += String.fromCodePoint(Number.parseInt(hex, 16));
                this.position += length;
            }
            else {
                // `\"` and `\\` — the two that env values (Windows paths, quoted args) contain.
                result += escaped;
            }
        }

        throw new Error("unterminated toml string");
    }

    private parseLiteralString(): string {
        const end = this.text.indexOf("'", this.position + 1);
        if (end < 0) {
            throw new Error("unterminated toml literal string");
        }

        const result = this.text.slice(this.position + 1, end);
        this.position = end + 1;
        return result;
    }

    private parseArray(): TomlValue[] {
        this.position += 1;
        const items: TomlValue[] = [];

        for (;;) {
            this.skipWhitespace();
            if (this.position >= this.text.length) {
                throw new Error("unterminated toml array");
            }

            if (this.text[this.position] === "]") {
                this.position += 1;
                return items;
            }

            items.push(this.parseValue());
            this.skipWhitespace();

            if (this.text[this.position] === ",") {
                this.position += 1;
            }
        }
    }

    private parseInlineTable(): { [key: string]: TomlValue } {
        this.position += 1;
        const table: { [key: string]: TomlValue } = {};

        for (;;) {
            this.skipWhitespace();
            if (this.position >= this.text.length) {
                throw new Error("unterminated toml inline table");
            }

            if (this.text[this.position] === "}") {
                this.position += 1;
                return table;
            }

            let key: string;
            if (this.text[this.position] === "\"") {
                key = this.parseBasicString();
            }
            else {
                const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.position));
                if (match == null) {
                    throw new Error(`invalid inline table key at offset ${this.position}`);
                }
                key = match[0];
                this.position += key.length;
            }

            this.skipWhitespace();
            if (this.text[this.position] !== "=") {
                throw new Error(`expected '=' at offset ${this.position}`);
            }
            this.position += 1;

            table[key] = this.parseValue();
            this.skipWhitespace();

            if (this.text[this.position] === ",") {
                this.position += 1;
            }
        }
    }
}

function unquoteKey(rawKey: string): string {
    if (rawKey.startsWith("\"") == false) {
        return rawKey;
    }

    const parsed = new TomlValueParser(rawKey).parse();
    return parsed as string;
}

/**
 * Brackets opened minus brackets closed outside strings and comments — positive means a
 * multi-line array or inline table continues on the next line.
 */
function bracketBalance(text: string): number {
    let balance = 0;
    let quote: string | null = null;

    for (let index = 0; index < text.length; index += 1) {
        const current = text[index];

        if (quote != null) {
            if (current === "\\" && quote === "\"") {
                index += 1;
            }
            else if (current === quote) {
                quote = null;
            }
            continue;
        }

        if (current === "\"" || current === "'") {
            quote = current;
        }
        else if (current === "#") {
            break;
        }
        else if (current === "[" || current === "{") {
            balance += 1;
        }
        else if (current === "]" || current === "}") {
            balance -= 1;
        }
    }

    return balance;
}

/** Strips a trailing `# comment` that sits outside any string. */
function stripComment(text: string): string {
    let quote: string | null = null;

    for (let index = 0; index < text.length; index += 1) {
        const current = text[index];

        if (quote != null) {
            if (current === "\\" && quote === "\"") {
                index += 1;
            }
            else if (current === quote) {
                quote = null;
            }
            continue;
        }

        if (current === "\"" || current === "'") {
            quote = current;
        }
        else if (current === "#") {
            return text.slice(0, index);
        }
    }

    return text;
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
        let rawValue = stripComment(match[2]);
        let balance = bracketBalance(rawValue);
        index += 1;

        while (balance > 0 && index < body.length) {
            const continuation = stripComment(body[index]);
            rawValue += `\n${continuation}`;
            balance += bracketBalance(continuation);
            index += 1;
        }

        statements.push({ key: unquoteKey(match[1]), rawValue: rawValue, start: start, end: index });
    }

    return statements;
}

function splitSections(lines: string[]): TomlSection[] {
    const sections: TomlSection[] = [{ header: null, serverName: null, subPath: "", body: [] }];
    let balance = 0;

    for (const line of lines) {
        const current = sections[sections.length - 1];

        if (balance > 0) {
            current.body.push(line);
            balance += bracketBalance(stripComment(line));
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

        const keyValueMatch = KEY_VALUE_PATTERN.exec(line);
        if (keyValueMatch != null) {
            balance = bracketBalance(stripComment(keyValueMatch[2]));
        }
    }

    return sections;
}

function parseStatementValue(statement: TomlStatement): TomlValue | null {
    try {
        const value = new TomlValueParser(statement.rawValue).parse();
        return value;
    }
    catch {
        return null;
    }
}

/**
 * Every `[mcp_servers.<name>]` table with a string `command`. A value this subset does not
 * read is skipped, not fatal — the file may hold servers this package never wrote.
 */
export function parseMcpServersToml(text: string): Record<string, McpServerEntry> {
    const sections = splitSections(text.split(/\r?\n/));
    const entries: Record<string, McpServerEntry> = {};
    const envTables: Record<string, Record<string, string>> = {};

    for (const section of sections) {
        if (section.serverName == null) {
            continue;
        }

        if (section.subPath === "env") {
            const envTable: Record<string, string> = {};
            for (const statement of readStatements(section.body)) {
                const value = parseStatementValue(statement);
                if (typeof value === "string") {
                    envTable[statement.key] = value;
                }
            }
            envTables[section.serverName] = envTable;
            continue;
        }

        if (section.subPath !== "") {
            continue;
        }

        let command: string | null = null;
        let args: string[] = [];
        const env: Record<string, string> = {};

        for (const statement of readStatements(section.body)) {
            const value = parseStatementValue(statement);

            if (statement.key === "command" && typeof value === "string") {
                command = value;
            }
            else if (statement.key === "args" && Array.isArray(value) == true) {
                args = (value as TomlValue[]).filter((item): item is string => typeof item === "string");
            }
            else if (statement.key === "env" && value != null && typeof value === "object" && Array.isArray(value) == false) {
                for (const [key, item] of Object.entries(value)) {
                    if (typeof item === "string") {
                        env[key] = item;
                    }
                }
            }
        }

        if (command != null) {
            entries[section.serverName] = { command: command, args: args, env: env };
        }
    }

    for (const [name, envTable] of Object.entries(envTables)) {
        if (entries[name] != null) {
            Object.assign(entries[name].env, envTable);
        }
    }

    return entries;
}

function quoteTomlString(value: string): string {
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");

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
