import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, formatResults } from "../src/modules/registration/registry";
import { ManagedSession, registrationMenu, syncMenu } from "../src/modules/registration/menu";
import { compareEntries } from "../src/modules/registration/comparison";
import { Prompter, displayWidth } from "../src/modules/registration/prompter";
import type { ConfigTarget, McpServerEntry } from "../src/modules/registration/types";
import { removeTempDirectory } from "./support/remove-temp-directory";

let directory: string;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-registration-ux-"));
    vi.stubEnv("AKMS_MCP_HOME", directory);
    vi.stubEnv("NO_COLOR", undefined);
});
afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await removeTempDirectory(directory, "akms-registration-ux-");
}, 15_000);
const entry = (description = "Saved host", host = "host.invalid"): McpServerEntry => ({ command: "npx", args: ["-y", "@akms/mcp-ssh"], env: { SSH_HOST: host, SSH_DESCRIPTION: description, SSH_PASSWORD: "fixture-private-password" } });
function fixture(count = 9) {
    const targets: ConfigTarget[] = ["claude-code", "codex"].map(id => {
        const file = path.join(directory, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => [`host_${i + 1}`, entry()]))));
        const read = (): Record<string, McpServerEntry> => JSON.parse(fs.readFileSync(file, "utf8"));
        return { id: id as "claude-code" | "codex", label: id === "codex" ? "Codex" : "Claude Code", location: file, detected: true, readEntries: read,
            writeEntry: vi.fn((name, value) => { fs.writeFileSync(file, JSON.stringify({ ...read(), [name]: value })); return { status: "written" as const, detail: file }; }),
            removeEntry: vi.fn(name => { const data = read(); delete data[name]; fs.writeFileSync(file, JSON.stringify(data)); return { status: "written" as const, detail: file }; }) };
    });
    let installed = false;
    const runtimeOptions: Registry["runtimeOptions"] = { find: kind => installed ? { command: process.execPath, args: [path.join(directory, `node_modules/@akms/mcp-${kind}/lib/cli.js`)], version: "0.3.1", linked: false } : null };
    const registry = new Registry(targets, path.join(directory, "registry.json"), runtimeOptions);
    return { registry, targets, runtimeOptions, install: () => { installed = true; }, register: () => registry.register(["claude-code", "codex"], [], registry.planRegistration(["claude-code", "codex"]).imports) };
}
async function screen(lines: string[], action: (prompter: Prompter) => unknown) {
    const input = new PassThrough(), output = new PassThrough(); let text = "";
    output.on("data", chunk => { text += chunk; }); input.end(lines.join("\n") + "\n");
    const prompter = new Prompter(input, output);
    try { await action(prompter); } finally { prompter.close(); }
    return text;
}
function terminal(action: (prompter: Prompter) => void, tty = true, width = 120) {
    const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: tty, columns: width }); let text = "";
    output.on("data", chunk => { text += chunk; });
    const prompter = new Prompter(input, output);
    try { action(prompter); return text; } finally { prompter.close(); }
}

describe("registration results and next actions", () => {
    it("reproduces Register with nine connections and no runtime, preserving all client entries without failure headings", async () => {
        const { registry, targets } = fixture();
        const before = targets.map(target => fs.readFileSync(target.location, "utf8"));
        const text = await screen(["claude-code", "codex", "a", "y"], p => registrationMenu(p, registry));
        const result = text.slice(text.indexOf("Registration saved."));
        expect(result).toContain("Connections: 9");
        expect(result).toContain("Waiting for runtime - SSH");
        expect(result).toContain("Install it from Runtime, then run Sync. Your existing entries keep working.");
        expect(result).toContain("Kept in Claude Code · Codex until akms_ssh is applied: host_1, host_2, host_3, host_4, host_5, host_6, host_7, host_8, host_9");
        expect(result.match(/Waiting for runtime/g)).toHaveLength(1);
        expect(result).not.toContain("Could not finish"); expect(result).not.toContain("FAILED");
        expect(result).not.toContain("Connection entry kept until");
        expect(text).not.toContain("\u001b"); expect(text).not.toContain("fixture-private-password");
        expect(targets.map(target => fs.readFileSync(target.location, "utf8"))).toEqual(before);
        expect(Object.keys(registry.read().connections)).toHaveLength(9);
    });
    it("counts connections separately from session entries when applying and inspecting a ready bundle", () => {
        const f = fixture(); f.register(); f.install();
        const results = f.registry.sync();
        expect(f.registry.formatResults(results)).toContain("Connections: 9");
        expect(f.registry.formatResults(results)).toContain("Service entries: 2 updated");
        expect(formatResults(f.registry.inspect())).toContain("Connections: 9");
        expect(f.registry.formatResults(f.registry.inspect())).toContain("2 already up to date");
        expect(Object.keys(f.targets[0].readEntries())).toEqual(["akms_ssh"]);
    });
    it("keeps actual service write failures red and separate from dependency waits", () => {
        const f = fixture(1); f.register(); f.install();
        vi.mocked(f.targets[0].writeEntry).mockReturnValue({ status: "unavailable", detail: "fixture failure" });
        const results = f.registry.sync();
        const text = terminal(p => p.write(f.registry.formatResults(results, "Sync results", p.paint)));
        expect(text).toContain("\u001b[31mCould not finish:");
        expect(text).toContain("\u001b[31mFAILED ");
        expect(text).toContain("Waiting for akms_ssh");
        expect(text).toContain("Kept in Claude Code until akms_ssh is applied: host_1");
        expect(text).not.toContain("Kept in Codex");
        expect(text).not.toContain("Waiting for runtime");
        expect(text.slice(text.indexOf("Could not finish"))).not.toContain("kept until");
        expect(f.targets[0].readEntries().host_1).toEqual(entry());
    });
    it("points to the current Sync menu while Register and config still direct users to open Sync", async () => {
        const f = fixture(1); f.register();
        f.targets[1].writeEntry("host_1", entry("Externally edited description"));
        const registration = await screen(["a", "y", "n"], p => registrationMenu(p, f.registry));
        expect(registration).toContain("Next: open Sync to compare settings and choose which version to use.");
        expect(registration).not.toContain("Next: choose an item below");
        const sync = await screen(["b"], p => syncMenu(p, f.registry));
        expect(sync).toContain("Next: choose an item below to compare settings and pick a version.");
        expect(sync).toContain("Review differences");
        expect(sync).not.toContain("Next: open Sync to compare settings");
        const config = await screen([], p => new ManagedSession({ kind: "ssh", targets: f.targets, registryPath: f.registry.file, runtimeOptions: f.runtimeOptions }).writeStatus(p));
        expect(config).toContain("Open Sync to review.");
        for(const text of [registration, sync, config]) expect(text).not.toContain("\u001b");
    });
    it("names the retaining service when nine old entries are removed only from the other service, including pipe output", async () => {
        const f = fixture(); f.register(); f.install();
        vi.mocked(f.targets[0].writeEntry).mockReturnValue({ status: "unavailable", detail: "fixture failure" });
        const text = await screen([], p => syncMenu(p, f.registry));
        expect(text).toContain("9 removed");
        expect(text).toContain("Kept in Claude Code until akms_ssh is applied: host_1, host_2, host_3, host_4, host_5, host_6, host_7, host_8, host_9");
        expect(text).not.toContain("Kept in Codex"); expect(text).not.toContain("Kept in Claude Code · Codex");
        expect(text).not.toContain("\u001b"); expect(text).not.toContain("fixture-private-password");
        expect(Object.keys(f.targets[0].readEntries())).toHaveLength(9);
        expect(Object.keys(f.targets[1].readEntries())).toEqual(["akms_ssh"]);
    });
    it("lists services separately when their retained connection names differ", async () => {
        const f = fixture(3); f.register(); f.targets[1].removeEntry("host_1");
        const text = await screen([], p => syncMenu(p, f.registry));
        expect(text).toContain("Kept in Claude Code until akms_ssh is applied: host_1, host_2, host_3");
        expect(text).toContain("Kept in Codex until akms_ssh is applied: host_2, host_3");
        expect(text).not.toContain("Kept in Claude Code · Codex");
        expect(text).not.toContain("\u001b");
    });
    it("offers differing, unimported connections in Sync and enters Import directly", async () => {
        const f = fixture(0);
        f.targets[0].writeEntry("host_note", entry("First description"));
        f.targets[1].writeEntry("host_note", entry("Second description")); f.register();
        const text = await screen(["import", "host_note", "0", "", "y", "b"], p => syncMenu(p, f.registry));
        expect(text).toContain("Not yet imported: 1 connection(s) with differing settings - open Import existing connections.");
        expect(text).toContain("[1] Claude Code"); expect(text).toContain("[2] Codex");
        expect(text).toContain("First description"); expect(text).toContain("Second description");
        expect(f.registry.read().connections.host_note.entry?.env.SSH_DESCRIPTION).toBe("First description");
        expect(text).not.toContain("fixture-private-password"); expect(text).not.toContain("\u001b");
    });
    it.each(["shared", "client", "decline"])("compares both descriptions in pending session mode and handles %s", async choice => {
        const f = fixture(1); f.register();
        f.targets[1].writeEntry("host_1", entry("Externally edited description"));
        const before = fs.readFileSync(f.targets[1].location, "utf8");
        const text = await screen(["0", choice === "decline" ? "client" : choice, choice === "decline" ? "n" : "y", "b"], p => syncMenu(p, f.registry));
        expect(text).toContain("Description differs. Connection settings match.");
        expect(text).toContain("[1] Saved in AKMS"); expect(text).toContain("[2] Currently in Codex");
        expect(text).toContain("Saved host"); expect(text).toContain("Externally edited description");
        expect(text).toContain("Which description should be used?");
        expect(text).toContain("Use 1: keep AKMS settings"); expect(text).toContain("Use 2: Codex -> all 2 services");
        expect(text).toContain("The old entry stays until the session server is ready.");
        expect(f.registry.read().connections.host_1.entry?.env.SSH_DESCRIPTION).toBe(choice === "client" ? "Externally edited description" : "Saved host");
        expect(fs.readFileSync(f.targets[1].location, "utf8")).toBe(before);
        if(choice !== "decline") { f.install(); f.registry.sync(); expect(Object.keys(f.targets[1].readEntries())).toEqual(["akms_ssh"]); }
    });
    it("shows both versions side by side on a wide terminal, masking secrets and wrapping complete values", () => {
        const left = "Original description " + "long text ".repeat(14), right = left + "changed suffix";
        const text = terminal(p => compareEntries(p, [{ label: "Saved in AKMS", entry: entry(left) }, { label: "Currently in Codex", entry: { ...entry(right, "changed.invalid"), env: { ...entry(right).env, SSH_PASSWORD: "different-private-password" } } }]), true, 100);
        const plain = stripVTControlCharacters(text);
        expect(plain).toMatch(/\[1\] Saved in AKMS +\| \[2\] Currently in Codex/);
        expect(plain).toContain("changed suffix"); expect(plain).toContain("(hidden)");
        for(const line of plain.split("\n")) expect(displayWidth(line)).toBeLessThan(100);
        expect(text).not.toContain("private-password");
    });
    it.each([[true, false], [true, true], [false, false]])("uses semantic colors only on TTY without NO_COLOR (tty=%s, noColor=%s)", (tty, noColor) => {
        vi.stubEnv("NO_COLOR", noColor ? "" : undefined);
        const f = fixture(1); const results = f.register();
        const text = terminal(p => {
            p.write(f.registry.formatResults(results, "Registration saved.", p.paint));
            const session = new ManagedSession({ kind: "ssh", targets: f.targets, registryPath: f.registry.file, runtimeOptions: f.runtimeOptions });
            f.targets[0].writeEntry("extra", entry()); session.writeStatus(p);
            const state = f.registry.read(); delete state.defaultMode; fs.writeFileSync(f.registry.file, JSON.stringify(state)); session.writeStatus(p);
        }, tty);
        expect(text).toContain("Needs attention: 1 connection(s)");
        expect(text).toContain("Import available: 1 connection(s)");
        expect(text).toContain("Registry update available.");
        expect(/\u001b\[\d+m/.test(text)).toBe(tty && !noColor);
        if(tty && !noColor) { expect(text).toContain("\u001b[33mWaiting"); expect(text).toContain("\u001b[32m0 updated"); expect(text).toContain("\u001b[2m"); }
        if(!tty) expect(text).not.toContain("\u001b");
    });
    it("keeps the existing symbols on legacy Windows terminals", async () => {
        vi.stubGlobal("process", { ...process, platform: "win32" });
        for(const key of ["WT_SESSION", "TERM_PROGRAM", "TERMINAL_EMULATOR", "ConEmuTask"]) vi.stubEnv(key, undefined);
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 }); let text = "";
        output.on("data", chunk => { text += chunk; }); const p = new Prompter(input, output);
        try {
            const done = p.select("Next step", [{ value: "ok", label: "Sync" }]);
            input.write("\r"); expect(await done).toBe("ok");
            expect(stripVTControlCharacters(text)).toContain("√ Next step · Sync");
            expect(stripVTControlCharacters(text)).toContain("> Sync");
            expect(stripVTControlCharacters(text)).not.toMatch(/[❯✔─]/);
        } finally { p.close(); }
    });
});
