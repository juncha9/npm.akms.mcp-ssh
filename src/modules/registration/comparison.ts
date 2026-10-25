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
export function writeWrapped(prompter: Prompter, text: string, indent = "", changed?: [number, number], style?: (text: string) => string): void {
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
            flush(); prompter.write((style ? style(line) : line) + "\n"); line = indent; width = displayWidth(indent);
        }
        const highlight = !!changed && index >= changed[0] && index < changed[1];
        if(highlight !== highlighted) { flush(); highlighted = highlight; }
        segment += character;
        width += size;
    }
    flush();
    prompter.write((style ? style(line) : line) + "\n");
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
    if(versions.length === 2 && prompter.width >= 90) {
        const width = Math.floor((prompter.width - 3) / 2);
        const wrap = (value: string, changed?: [number, number]) => {
            const lines: { text: string; width: number }[] = [{ text: "", width: 0 }];
            for(const [index, character] of Array.from(value).entries()) {
                const size = displayWidth(character);
                if(lines[lines.length - 1].width + size > width) lines.push({ text: "", width: 0 });
                const line = lines[lines.length - 1];
                line.text += changed && index >= changed[0] && index < changed[1] ? prompter.paint.accent(prompter.paint.bold(character)) : character;
                line.width += size;
            }
            return lines;
        };
        const row = (left: ReturnType<typeof wrap>, right: ReturnType<typeof wrap>) => {
            for(let line = 0; line < Math.max(left.length, right.length); line++) {
                prompter.write(`${left[line]?.text ?? ""}${" ".repeat(width - (left[line]?.width ?? 0))} | ${right[line]?.text ?? ""}\n`);
            }
        };
        prompter.write("\n");
        row(wrap(`[1] ${plainText(versions[0].label)}`), wrap(`[2] ${plainText(versions[1].label)}`));
        for(let field = 0; field < fields.length; field++) {
            prompter.write(`\n${prompter.paint.dim(fieldName(fields[field]))}\n`);
            row(wrap(values[field][0], changedRange(values[field], 0)), wrap(values[field][1], changedRange(values[field], 1)));
        }
        if(values.some(row => row.includes("(hidden)"))) prompter.write(prompter.paint.dim("\nSecret values are hidden.\n"));
        prompter.write("\n");
        return;
    }
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
