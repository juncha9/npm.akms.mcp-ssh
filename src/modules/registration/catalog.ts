import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpKind } from "./types";

export interface CatalogConnection { name: string; env: Record<string, string> }
export const LONGEST_TOOL_NAME_LENGTH: Record<McpKind, number> = { db: 13, ssh: 17, wsl: 17, s3: 11 };
export const sessionToolName = (connection: string, tool: string): string => `${connection}__${tool}`;
export const maxConnectionNameLength = (kind: McpKind): number => 64 - `mcp__akms_${kind}__`.length - 2 - LONGEST_TOOL_NAME_LENGTH[kind];
export const defaultCatalogPath = (): string => path.join(process.env.AKMS_MCP_HOME ? path.resolve(process.env.AKMS_MCP_HOME) : path.join(os.homedir(), ".akms", "mcp"), "registry.json");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Server-only reader: no writes, locks, management imports, or secret diagnostics. */
export function readCatalog(kind: McpKind, file?: string): { file: string; connections: CatalogConnection[]; problems: string[]; rejected?: { name: string; reason: string }[] } {
    const result: ReturnType<typeof readCatalog> = { file: file ?? "", connections: [], problems: [] };
    const reject = (name: string, reason: string) => { result.problems.push(reason); (result.rejected ??= []).push({ name, reason }); };
    try {
        result.file = file ?? defaultCatalogPath();
        let catalog: unknown;
        try { catalog = JSON.parse(fs.readFileSync(result.file, "utf8")); }
        catch(error) {
            result.problems.push((error as NodeJS.ErrnoException).code === "ENOENT" ? "Catalog file is missing." : "Cannot read catalog JSON. Check the file and its permissions.");
            return result;
        }
        if(!record(catalog) || ![1, 2].includes(catalog.version as number) || !record(catalog.connections)) {
            result.problems.push("Unsupported or invalid catalog format. Expected version 1 or 2.");
            return result;
        }
        for(const [name, connection] of Object.entries(catalog.connections)) {
            if(!record(connection)) { result.problems.push("An invalid catalog connection was skipped."); continue; }
            if(connection.kind !== kind || connection.entry === null) continue;
            if(!record(connection.entry) || !record(connection.entry.env) || !Object.values(connection.entry.env).every(value => typeof value === "string")) {
                reject(name, "A connection with invalid environment settings was skipped."); continue;
            }
            if(!name || name.length > maxConnectionNameLength(kind) || !/^[A-Za-z0-9_-]+$/.test(name)) {
                reject(name, `A connection with an invalid name was skipped. Use 1-${maxConnectionNameLength(kind)} ASCII letters, digits, underscores or hyphens.`); continue;
            }
            result.connections.push({ name, env: { ...connection.entry.env } as Record<string, string> });
        }
    } catch { result.problems.push("Cannot read catalog settings."); }
    return result;
}
