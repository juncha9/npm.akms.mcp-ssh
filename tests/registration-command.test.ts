import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigCommand } from "../src/modules/manage";
import { Registry } from "../src/modules/registration/registry";
import { createJsonFileTarget } from "../src/modules/manage/targets/json-file";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-ssh-standalone-")); vi.stubEnv("AKMS_MCP_HOME", directory); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
function fixture({ legacy = true } = {}) {
    if(legacy) fs.writeFileSync(path.join(directory, "registry.json"), JSON.stringify({ version: 1, clients: [], connections: {} }));
    const targets = ["cursor", "claude-desktop"].map((id) => createJsonFileTarget({ id: id as "cursor" | "claude-desktop", label: id, filePath: path.join(directory, id + ".json") }));
    const registryPath = path.join(directory, "registry.json");
    const runtimeOptions: Registry["runtimeOptions"] = {
        latest: vi.fn(async () => { throw new Error("Main menu must not query npm."); }),
        check: vi.fn(async () => ({ ok: true, server: "fixture", version: "1.0.0", tools: 1, exitCode: 0, stderr: [] })),
        find: () => ({ command: process.execPath, args: [path.join(directory, "node_modules", "@akms", "mcp-ssh", "lib", "cli.js")], version: "1.0.0", linked: false }),
        install: async () => { throw new Error("Tests must not install global packages."); },
    };
    return { targets, registryPath, runtimeOptions, registry: new Registry(targets, registryPath, runtimeOptions) };
}
async function run(values: ReturnType<typeof fixture>, lines: string[], mode: "config" | "register" | "sync" = "config") {
    const input = new PassThrough(); const output = new PassThrough(); let text = "";
    output.on("data", (chunk) => { text += chunk; });
    input.end(lines.join("\n") + "\n");
    await runConfigCommand({ input, output, targets: values.targets, registryPath: values.registryPath, runtimeOptions: values.runtimeOptions, mode });
    return text;
}
describe("standalone ssh registration", () => {
    it("keeps notices visible, then returns to a clean menu on a terminal", async () => {
        const values = fixture({ legacy: false });
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
        let text = "old terminal output";
        output.on("data", (chunk) => { text += chunk; });
        const page = () => text.split("\u001b[2J\u001b[H").at(-1)!.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
        const press = async (key: string) => { input.write(key); await new Promise<void>((resolve) => setImmediate(resolve)); };
        const running = runConfigCommand({ input, output, targets: values.targets, registryPath: values.registryPath, runtimeOptions: values.runtimeOptions });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(page()).toContain("Register");
        expect(page()).not.toContain("old terminal output");
        expect(page()).not.toContain(values.registryPath);
        await press("\r");
        expect(page()).toContain("Register an AI service first");
        expect(page()).toContain("Press Enter to continue");
        await press("\u001b");
        expect(page()).toContain("Register");
        expect(page()).not.toContain("Register an AI service first:");
        expect(page()).not.toContain("Press Enter to continue");
        await press("\u001b");
        await running;
        expect(fs.existsSync(values.registryPath)).toBe(false);
        expect(text).not.toContain("\u001b[3J");
    });

    it("registers multiple services, adds once and removes from both without the helper", async () => {
        const values = fixture();
        await run(values, ["cursor", "claude-desktop", "a", "y"], "register");
        expect(values.registry.read().clients).toEqual(["cursor", "claude-desktop"]);
        const text = await run(values, ["a","host","host.local","user","user","auth","agent","save","n","y","q"]);
        const connections = values.targets[0].readEntries();
        expect(Object.keys(connections)).toHaveLength(1);
        expect(values.targets[1].readEntries()).toEqual(connections);
        expect(values.runtimeOptions.check).toHaveBeenCalledExactlyOnceWith(Object.values(connections)[0]);
        expect(values.runtimeOptions.latest).not.toHaveBeenCalled();
        expect(text).toContain("Startup check");
        expect(text).toContain("Register");
        expect(text).toContain("Sync");
        expect(text).not.toContain("Switch client");
        expect(text).not.toContain("Change client");
        const name = Object.keys(connections)[0];
        await run(values, [name, "r", "y", "q"]);
        expect(values.targets[0].readEntries()).toEqual({});
        expect(values.targets[1].readEntries()).toEqual({});
    });
    it("shows legacy synced connections after the first registration without duplicate entries", async () => {
        const values = fixture();
        const existing = { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: {} };
        for(const target of values.targets) target.writeEntry("legacy-connection", existing);
        const originals = values.targets.map((target) => fs.readFileSync(target.location, "utf8"));
        const text = await run(values, ["register", "cursor", "claude-desktop", "a", "y", "q"]);
        expect(Object.keys(values.registry.target("ssh").readEntries())).toEqual(["legacy-connection"]);
        expect(text).toContain("Imported 1 existing connection(s)");
        expect(text).toContain("legacy-connection");
        expect(text).not.toContain("Switch client");
        values.targets.forEach((target, index) => expect(fs.readFileSync(target.location, "utf8")).toBe(originals[index]));
    });
    it("shows all menus and blocks Add until a service is registered", async () => {
        const values = fixture({ legacy: false });
        const existing = { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: {} };
        values.targets[0].writeEntry("legacy-connection", existing);
        const before = fs.readFileSync(values.targets[0].location, "utf8");
        const text = await run(values, ["a", "q"]);
        expect(text).toContain("Register");
        expect(text).toContain("Sync");
        expect(text).toContain("Import existing connections");
        expect(text).toContain("Register an AI service first");
        expect(text).not.toContain("Apply this registration?");
        expect(text).not.toContain("Save locally");
        expect(fs.readFileSync(values.targets[0].location, "utf8")).toBe(before);
        expect(fs.existsSync(values.targets[1].location)).toBe(false);
        expect(fs.existsSync(values.registryPath)).toBe(false);
    });
    it("exposes register from its own CLI and exits cleanly on closed input", () => {
        const env = { ...process.env, AKMS_MCP_HOME: directory, HOME: directory, USERPROFILE: directory, CODEX_HOME: path.join(directory, ".codex"), APPDATA: path.join(directory, "AppData") };
        const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "register"], { env, input: "q\n", encoding: "utf8", timeout: 15000, windowsHide: true });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Register");
        expect(fs.existsSync(path.join(directory, "registry.json"))).toBe(false);
    }, 20000);
});


describe("runtime preparation before editing", () => {
    it("stops before opening a legacy entry form when installation fails", async () => {
        const values = fixture();
        values.registry.register(["cursor"]);
        const entry = { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: {"SSH_HOST":"ssh.local","SSH_USER":"test"} };
        values.registry.write("ssh", "legacy", entry);
        values.runtimeOptions.find = () => null;
        const install = vi.fn(async () => { throw new Error("isolated install failure"); });
        values.runtimeOptions.install = install;
        const text = await run(values, ["legacy", "e", "q"]);
        expect(install).toHaveBeenCalledTimes(1);
        expect(text).toContain("isolated install failure");
        expect(text).not.toContain("Editing legacy");
        expect(values.targets[0].readEntries().legacy).toEqual(entry);
    });

    it("uses the package version to offer updates before Add and Edit", async () => {
        const values = fixture();
        values.registry.register(["cursor"]);
        values.registry.write("ssh", "legacy", { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: {"SSH_HOST":"ssh.local","SSH_USER":"test"} });
        const runtime = values.runtimeOptions.find!("ssh")!;
        values.runtimeOptions.find = () => ({ ...runtime, version: "0.0.1" });
        for(const action of [["a"], ["legacy", "e"]]) {
            const text = await run(values, [...action, "n", "ESC", "q"]);
            expect(text).toContain("Installed runtime: 0.0.1. This setup:");
            expect(text).toContain("Update the AKMS runtime to the latest release before continuing?");
        }
    });
});


it.each(["npx", "node"])("edits a custom %s entry without requiring a runtime", async (command) => {
    const values = fixture();
    values.registry.register(["cursor"]);
    const args = command === "npx" ? ["-y", "@akms/mcp-ssh", "--custom"] : [path.join(directory, "node_modules", "@akms", "mcp-ssh", "lib", "cli.js"), "--custom"];
    const entry = { command, args, env: {"SSH_HOST":"ssh.local","SSH_USER":"user"} };
    values.registry.write("ssh", "custom", entry);
    const find = vi.fn(() => null);
    const install = vi.fn(async () => { throw new Error("must not install"); });
    values.runtimeOptions.find = find; values.runtimeOptions.install = install;
    values.runtimeOptions.check = vi.fn(async () => ({ ok: false, exitCode: 7, detail: "fixture startup failure", stderr: [] }));
    const text = await run(values, ["custom","e","description","updated","save","n","y","q"]);
    const saved = values.targets[0].readEntries().custom;
    expect(saved.command).toBe(command); expect(saved.args).toEqual(args);
    expect(saved.env.SSH_DESCRIPTION).toBe("updated");
    expect(find).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    expect(text).not.toContain("Update the AKMS runtime");
    expect(values.runtimeOptions.check).toHaveBeenCalledWith(saved);
    expect(text).toContain("FAILED custom: exit 7");
    expect(text).toContain("Settings remain saved.");
});
