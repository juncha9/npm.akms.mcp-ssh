import type { Readable, Writable } from "node:stream";

import { SINGLE_HOST_ENV } from "@/_defs";
import type { ConfigTarget, ConfigWriteResult, HostSetupAnswers, McpServerEntry, SshHostProfile } from "@/_types";
import { loadHostProfile } from "@/modules/config";

import { runConnectionCheck } from "./connection-check";
import { answersToEntry, entryToAnswers, isOurEntry, summarizeEntry } from "./entry";
import { PromptClosedError, Prompter } from "./prompter";
import { askHostQuestions } from "./questions";
import { formatClaudeAddCommand, listConfigTargets, renderMcpServerTable } from "./targets";

export { runConnectionCheck } from "./connection-check";
export type { ConnectionCheckResult } from "./connection-check";

/** Env values masked in the on-screen preview; the print view shows them, since it is for pasting. */
const SECRET_ENV_NAMES: string[] = [
    SINGLE_HOST_ENV.PASSWORD,
    SINGLE_HOST_ENV.PASSPHRASE,
    SINGLE_HOST_ENV.JUMP_PASSWORD,
    SINGLE_HOST_ENV.JUMP_PASSPHRASE,
];

export interface ConfigCommandOptions {
    input: Readable;
    output: Writable;
    /** Supported clients; tests pass their own so nothing under the real home is touched. */
    targets?: ConfigTarget[];
    /** Client to open on; defaults to the first detected one. */
    targetId?: string;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function maskSecrets(entry: McpServerEntry): McpServerEntry {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry.env)) {
        if (SECRET_ENV_NAMES.includes(name) == true) {
            env[name] = "********";
            continue;
        }
        env[name] = value;
    }

    return { ...entry, env: env };
}

/** The entry as it reads inside the target's own file — a TOML table for Codex, JSON otherwise. */
function formatForTarget(target: ConfigTarget, name: string, entry: McpServerEntry): string {
    if (target.id === "codex") {
        return renderMcpServerTable(name, entry);
    }

    return `"${name}": ${JSON.stringify(entry, null, 4)}\n`;
}

function indent(text: string): string {
    return text.replace(/\n$/, "").split("\n").map((line) => `    ${line}`).join("\n");
}

function reportWrite(output: Writable, result: ConfigWriteResult, action: string): void {
    if (result.status === "written") {
        output.write(`  ${action} — ${result.detail}\n`);
        output.write("  Restart the client (or reconnect it from its MCP menu) to pick up the change.\n\n");
        return;
    }

    output.write(`  Not ${action.toLowerCase()}: ${result.detail}\n\n`);
}

/**
 * Builds a profile from an entry's env the way the server will at startup — so a value the
 * server would reject is caught here, not when the agent first calls a tool.
 */
function profileFromEntry(output: Writable, entry: McpServerEntry): SshHostProfile | null {
    try {
        const profile = loadHostProfile(entry.env);
        if (profile == null) {
            output.write("  The entry has no host.\n");
        }
        return profile;
    }
    catch (ex) {
        output.write(`  The server would refuse to start with this entry: ${errorMessage(ex)}\n`);
        return null;
    }
}

/**
 * Connects with the answers and settles the host keys before anything is written.
 * Pinning is offered while the operator is at the terminal anyway, so it becomes the
 * default instead of a step nobody takes.
 *
 * @returns The answers to write, or null when the operator cancelled.
 */
async function verifyAnswers(prompter: Prompter, output: Writable, initial: HostSetupAnswers): Promise<HostSetupAnswers | null> {
    let answers = initial;

    for (;;) {
        const testNow = await prompter.askYesNo("Test the connection now?", true);
        if (testNow == false) {
            return answers;
        }

        output.write("\n");
        const profile = profileFromEntry(output, answersToEntry(answers));

        if (profile != null) {
            const result = await runConnectionCheck(profile, output);
            output.write("\n");

            if (result.connected == true) {
                if (result.hostKeyFingerprint != null && answers.hostKeyFingerprint == null) {
                    const pin = await prompter.askYesNo(`Pin the host key ${result.hostKeyFingerprint}? (a changed key then aborts the connection)`, true);
                    if (pin == true) {
                        answers = { ...answers, hostKeyFingerprint: result.hostKeyFingerprint };
                    }
                }

                if (result.jumpHostKeyFingerprint != null && answers.jumpHost != null && answers.jumpHostKeyFingerprint == null) {
                    const pin = await prompter.askYesNo(`Pin the jump host key ${result.jumpHostKeyFingerprint}?`, true);
                    if (pin == true) {
                        answers = { ...answers, jumpHostKeyFingerprint: result.jumpHostKeyFingerprint };
                    }
                }

                return answers;
            }

            // A pinned key that no longer matches is the one failure the wizard can settle,
            // and the one it must not settle by default: it is also what an impersonated
            // host looks like.
            const hostKeyChanged = result.hostKeyFingerprint != null
                && answers.hostKeyFingerprint != null
                && result.hostKeyFingerprint !== answers.hostKeyFingerprint;
            if (hostKeyChanged == true) {
                output.write("  The host presented a different key than the pinned one. Re-pin only if you know it was rebuilt.\n");
                const repin = await prompter.askYesNo(`Pin ${result.hostKeyFingerprint} instead?`, false);
                if (repin == true) {
                    answers = { ...answers, hostKeyFingerprint: result.hostKeyFingerprint ?? undefined };
                    continue;
                }
            }

            const jumpKeyChanged = result.jumpHostKeyFingerprint != null
                && answers.jumpHostKeyFingerprint != null
                && result.jumpHostKeyFingerprint !== answers.jumpHostKeyFingerprint;
            if (jumpKeyChanged == true) {
                output.write("  The jump host presented a different key than the pinned one. Re-pin only if you know it was rebuilt.\n");
                const repin = await prompter.askYesNo(`Pin ${result.jumpHostKeyFingerprint} instead?`, false);
                if (repin == true) {
                    answers = { ...answers, jumpHostKeyFingerprint: result.jumpHostKeyFingerprint ?? undefined };
                    continue;
                }
            }
        }

        const next = await prompter.askChoice(
            "What now?",
            [
                { key: "r", label: "retry the check" },
                { key: "e", label: "edit the answers" },
                { key: "w", label: "write it anyway" },
                { key: "c", label: "cancel" },
            ],
            "e",
        );

        if (next === "c") {
            return null;
        }

        if (next === "w") {
            return answers;
        }

        if (next === "e") {
            output.write("\n");
            answers = await askHostQuestions(prompter, answers);
        }
    }
}

/**
 * Add (no `existingName`) or edit one host: questions → connection check → preview →
 * write. A renamed host is written under the new name first, then the old name removed,
 * so a failed write never leaves the host unregistered.
 */
async function addOrEditHost(
    prompter: Prompter,
    output: Writable,
    target: ConfigTarget,
    entries: Record<string, McpServerEntry>,
    existingName?: string,
): Promise<void> {
    let existing: HostSetupAnswers | undefined;
    if (existingName != null) {
        existing = entryToAnswers(existingName, entries[existingName]);
        output.write(`\nEditing ${existingName}\n`);
    }
    else {
        output.write("\nAdding a host\n");
    }

    const asked = await askHostQuestions(prompter, existing);
    output.write("\n");

    const answers = await verifyAnswers(prompter, output, asked);
    if (answers == null) {
        output.write("  Cancelled — nothing was written.\n\n");
        return;
    }

    if (answers.name !== existingName && entries[answers.name] != null) {
        const replace = await prompter.askYesNo(`"${answers.name}" already exists in this file. Replace it?`, false);
        if (replace == false) {
            output.write("  Cancelled — nothing was written.\n\n");
            return;
        }
    }

    const entry = answersToEntry(answers);
    output.write(`\n  This goes into ${target.location}:\n\n`);
    output.write(`${indent(formatForTarget(target, answers.name, maskSecrets(entry)))}\n\n`);

    const confirmed = await prompter.askYesNo("Write it?", true);
    if (confirmed == false) {
        output.write("  Not written. The print view (p) gives the same entry ready to paste.\n\n");
        return;
    }

    const written = target.writeEntry(answers.name, entry);
    reportWrite(output, written, "Written");

    if (written.status === "written" && existingName != null && existingName !== answers.name) {
        const removed = target.removeEntry(existingName);
        if (removed.status === "unavailable") {
            output.write(`  The old name ${existingName} is still there: ${removed.detail}\n\n`);
        }
    }
}

/** Connects with a stored entry, and offers to pin an unpinned key by adding just that line. */
async function checkHost(
    prompter: Prompter,
    output: Writable,
    target: ConfigTarget,
    name: string,
    entry: McpServerEntry,
): Promise<void> {
    output.write("\n");
    const profile = profileFromEntry(output, entry);
    if (profile == null) {
        output.write("\n");
        return;
    }

    const result = await runConnectionCheck(profile, output);
    output.write("\n");

    if (result.connected == false) {
        return;
    }

    const env = { ...entry.env };
    let changed = false;

    if (result.hostKeyFingerprint != null && env[SINGLE_HOST_ENV.HOST_KEY] == null) {
        const pin = await prompter.askYesNo(`Pin the host key ${result.hostKeyFingerprint}?`, true);
        if (pin == true) {
            env[SINGLE_HOST_ENV.HOST_KEY] = result.hostKeyFingerprint;
            changed = true;
        }
    }

    if (result.jumpHostKeyFingerprint != null && env[SINGLE_HOST_ENV.JUMP_HOST_KEY] == null) {
        const pin = await prompter.askYesNo(`Pin the jump host key ${result.jumpHostKeyFingerprint}?`, true);
        if (pin == true) {
            env[SINGLE_HOST_ENV.JUMP_HOST_KEY] = result.jumpHostKeyFingerprint;
            changed = true;
        }
    }

    if (changed == true) {
        const written = target.writeEntry(name, { ...entry, env: env });
        reportWrite(output, written, "Pinned");
    }
}

/** Every form the entry can be pasted in, real secrets included — this view exists to be copied. */
function printHost(output: Writable, name: string, entry: McpServerEntry): void {
    output.write("\n  JSON — Claude Desktop, Cursor, .mcp.json (inside \"mcpServers\"):\n\n");
    output.write(`${indent(`"${name}": ${JSON.stringify(entry, null, 4)}`)}\n\n`);
    output.write("  TOML — Codex (~/.codex/config.toml):\n\n");
    output.write(`${indent(renderMcpServerTable(name, entry))}\n\n`);
    output.write("  Claude Code CLI (bash / zsh / Git Bash):\n\n");
    output.write(`${indent(formatClaudeAddCommand(name, entry))}\n\n`);
}

async function pickHost(prompter: Prompter, output: Writable, names: string[]): Promise<string | null> {
    if (names.length === 0) {
        output.write("  No hosts yet — add one with a.\n\n");
        return null;
    }

    if (names.length === 1) {
        return names[0];
    }

    for (;;) {
        const answer = await prompter.ask("Which host (number or name, empty to go back)");
        if (answer === "") {
            return null;
        }

        const index = Number(answer);
        if (Number.isInteger(index) == true && index >= 1 && index <= names.length) {
            return names[index - 1];
        }

        if (names.includes(answer) == true) {
            return answer;
        }

        output.write(`  No host "${answer}".\n`);
    }
}

function renderHostList(output: Writable, target: ConfigTarget, entries: Record<string, McpServerEntry>): string[] {
    const names = Object.keys(entries).filter((name) => isOurEntry(entries[name]) == true);
    const otherCount = Object.keys(entries).length - names.length;

    output.write(`\n${target.label} — ${target.location}\n\n`);

    if (names.length === 0) {
        output.write("  No SSH hosts registered here yet.\n");
    }
    else {
        const rows = names.map((name, index) => {
            const summary = summarizeEntry(entries[name]);
            return [String(index + 1), name, summary.endpoint, summary.auth, summary.notes];
        });
        const header = ["#", "Server", "Endpoint", "Auth", "Notes"];
        const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));

        for (const row of [header, ...rows]) {
            const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
            output.write(`  ${line}\n`);
        }
    }

    if (otherCount > 0) {
        output.write(`\n  ${otherCount} other MCP server(s) in this file are not managed here.\n`);
    }

    output.write("\n");
    return names;
}

/**
 * `akms-mcp-ssh config` — an interactive manager for the SSH hosts registered in an MCP
 * client's config: list, add, edit, remove, check, print, switch client. The `SSH_*`
 * names never have to be typed; the wizard asks plain questions and writes them.
 *
 * @returns Process exit code.
 */
export async function runConfigCommand(options: ConfigCommandOptions): Promise<number> {
    const { input, output } = options;
    const targets = options.targets ?? listConfigTargets();

    let target = targets[0];
    if (options.targetId != null) {
        const requested = targets.find((candidate) => candidate.id === options.targetId);
        if (requested == null) {
            output.write(`Unknown client "${options.targetId}". One of: ${targets.map((candidate) => candidate.id).join(", ")}\n`);
            return 1;
        }
        target = requested;
    }

    const prompter = new Prompter(input, output);

    try {
        for (;;) {
            let entries: Record<string, McpServerEntry> = {};
            let names: string[] = [];
            let readable = true;

            try {
                entries = target.readEntries();
                names = renderHostList(output, target, entries);
            }
            catch (ex) {
                readable = false;
                output.write(`\n${target.label} — ${target.location}\n\n  Cannot read it: ${errorMessage(ex)}\n  Fix the file by hand, or switch to another client.\n\n`);
            }

            let menu = "  t) switch client   q) quit";
            if (readable == true && names.length > 0) {
                menu = "  a) add   e) edit   r) remove   c) check   p) print   t) switch client   q) quit";
            }
            else if (readable == true) {
                menu = "  a) add   t) switch client   q) quit";
            }
            output.write(`${menu}\n`);

            const action = (await prompter.ask("Choice")).toLowerCase();

            if (action === "q" || action === "quit") {
                return 0;
            }

            if (action === "t") {
                const picked = await prompter.askChoice(
                    "Which client?",
                    targets.map((candidate) => {
                        let mark = "";
                        if (candidate.detected == true) {
                            mark = "  (detected)";
                        }
                        return { key: candidate.id, label: `${candidate.label} — ${candidate.location}${mark}` };
                    }),
                    target.id,
                );
                target = targets.find((candidate) => candidate.id === picked) ?? target;
                continue;
            }

            if (readable == false) {
                output.write("  Not available while the file cannot be read.\n");
                continue;
            }

            try {
                if (action === "a") {
                    await addOrEditHost(prompter, output, target, entries);
                    continue;
                }

                if (action === "e" || action === "r" || action === "c" || action === "p") {
                    const name = await pickHost(prompter, output, names);
                    if (name == null) {
                        continue;
                    }

                    if (action === "e") {
                        await addOrEditHost(prompter, output, target, entries, name);
                    }
                    else if (action === "r") {
                        const remove = await prompter.askYesNo(`Remove ${name} from ${target.location}?`, false);
                        if (remove == true) {
                            reportWrite(output, target.removeEntry(name), "Removed");
                        }
                    }
                    else if (action === "c") {
                        await checkHost(prompter, output, target, name, entries[name]);
                    }
                    else {
                        printHost(output, name, entries[name]);
                    }
                    continue;
                }

                output.write(`  Unknown choice "${action}".\n`);
            }
            catch (ex) {
                if (ex instanceof PromptClosedError) {
                    throw ex;
                }
                output.write(`  Failed: ${errorMessage(ex)}\n\n`);
            }
        }
    }
    catch (ex) {
        // Input ending (Ctrl+D, a piped script running out) is a way to leave, not a crash.
        if (ex instanceof PromptClosedError) {
            output.write("\n");
            return 0;
        }
        throw ex;
    }
    finally {
        prompter.close();
    }
}
