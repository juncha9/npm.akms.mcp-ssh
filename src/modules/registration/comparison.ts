import { differingFields } from "./registry";
import { displayWidth } from "./prompter";
import type { Prompter } from "./prompter";
import type { McpServerEntry } from "./types";

export const visibleField = /^(DB_DRIVER|DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_SSL|DB_DESCRIPTION|SSH_HOST|SSH_PORT|SSH_USER|SSH_DESCRIPTION|WSL_DISTRO|WSL_USER|WSL_DESCRIPTION|S3_BACKEND|S3_BUCKET|S3_REGION|S3_PREFIX|S3_AUTH|S3_DESCRIPTION)$/;
export const plainText = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");

export function descriptionOnly(entries: McpServerEntry[]): boolean {
    const fields = differingFields(entries);
    return fields.length > 0 && fields.every((field) => /^env\.(DB|SSH|WSL|S3)_DESCRIPTION$/.test(field));
}

const fieldName = (field: string): string => {
    const key = field.replace(/^env\./, "");
    if(/^(DB|SSH|WSL|S3)_DESCRIPTION$/.test(key)) return "Description";
    const names: Record<string, string> = { command: "Launch command", args: "Launch arguments", DB_HOST: "Host", SSH_HOST: "Host", DB_PORT: "Port", SSH_PORT: "Port", DB_NAME: "Database", DB_USER: "User", SSH_USER: "User", WSL_USER: "User", WSL_DISTRO: "Linux distribution", S3_BUCKET: "Bucket", S3_REGION: "Region", S3_PREFIX: "Key prefix" };
    return Object.hasOwn(names, key) ? names[key] : plainText(key);
};

/** Wrap complete values, including Korean text, without clipping the differing suffix. */
export function writeWrapped(prompter: Prompter, text: string, indent = "", changed?: [number, number]): void {
    const characters = Array.from(plainText(text));
    let line = indent;
    let width = displayWidth(indent);
    let segment = "";
    let highlighted = false;
    const flush = () => { line += highlighted ? prompter.paint.accent(prompter.paint.bold(segment)) : segment; segment = ""; };
    for(let index = 0; index < characters.length; index++) {
        const character = characters[index];
        const size = displayWidth(character);
        if(width + size > prompter.width) {
            flush(); prompter.write(line + "\n"); line = indent; width = displayWidth(indent);
        }
        const highlight = !!changed && index >= changed[0] && index < changed[1];
        if(highlight !== highlighted) { flush(); highlighted = highlight; }
        segment += character;
        width += size;
    }
    flush();
    prompter.write(line + "\n");
}

/** Mark only the changed middle; compare masked values, never secrets. */
function changedRange(values: string[], index: number): [number, number] | undefined {
    if(values.length !== 2 || values[0] === values[1]) return undefined;
    const current = Array.from(values[index]);
    const other = Array.from(values[1 - index]);
    let start = 0, end = current.length, otherEnd = other.length;
    while(start < end && start < otherEnd && current[start] === other[start]) start++;
    while(end > start && otherEnd > start && current[end - 1] === other[otherEnd - 1]) { end--; otherEnd--; }
    return [start, end];
}

export function compareEntries(prompter: Prompter, versions: { label: string; entry: McpServerEntry }[]): void {
    const entries = versions.map((version) => version.entry);
    const fields = differingFields(entries);
    writeWrapped(prompter, descriptionOnly(entries) ? "Description differs. Connection settings match." : `${fields.length} setting(s) differ.`);
    const values = fields.map((field) => {
        const key = field.replace(/^env\./, "");
        return versions.map(({ entry }) => field.startsWith("env.") && visibleField.test(key)
            ? (Object.hasOwn(entry.env, key) ? plainText(entry.env[key]) || "(empty)" : "(not set)")
            : "(hidden)");
    });
    for(let index = 0; index < versions.length; index++) {
        prompter.write("\n");
        writeWrapped(prompter, `[${index + 1}] ${versions[index].label}`);
        for(let field = 0; field < fields.length; field++) {
            writeWrapped(prompter, fieldName(fields[field]), "  ");
            writeWrapped(prompter, values[field][index], "    ", changedRange(values[field], index));
        }
    }
    if(values.some((row) => row.includes("(hidden)"))) prompter.write("\nSecret values are hidden.\n");
    prompter.write("\n");
}
