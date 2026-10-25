import fs from "node:fs";
import { removeTempDirectory } from "./support/remove-temp-directory";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/modules/registration/registry";
import { ManagedSession, updatesMenu } from "../src/modules/registration/menu";
import { latestRuntimeVersion, type GlobalRuntime } from "../src/modules/registration/runtime";
import { Prompter } from "../src/modules/registration/prompter";
import type { McpKind } from "../src/modules/registration/types";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms updates ")); vi.stubEnv("AKMS_MCP_HOME", directory); fs.writeFileSync(path.join(directory, "registry.json"), JSON.stringify({ version: 1, clients: [], connections: {} })); });
afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await removeTempDirectory(directory, "akms updates ");
}, 15_000);
async function screen(lines: string[], registry: Registry) {
    const input = new PassThrough(), output = new PassThrough(); let text = "";
    output.on("data", chunk => { text += chunk; }); input.end(lines.join("\n") + "\n");
    const prompter = new Prompter(input, output);
    try { await updatesMenu(prompter, registry); } finally { prompter.close(); }
    return text;
}
function fixture() {
    const runtime = (version: string, linked = false): GlobalRuntime => ({ command: process.execPath, args: [path.join(directory, "fixture.js")], version, linked });
    const installed: Partial<Record<McpKind, GlobalRuntime>> = { db: runtime("1.0.0"), ssh: runtime("2.0.0"), wsl: runtime("1.0.0", true) };
    const latest = vi.fn(async (_kind: McpKind) => "2.0.0");
    const install = vi.fn(async (kind: McpKind) => { installed[kind] = runtime("2.0.0"); });
    const check = vi.fn(async () => ({ ok: true, server: "fixture", version: "2.0.0", tools: 3, exitCode: 0, stderr: [] }));
    const options = { find: (kind: McpKind) => installed[kind] ?? null, latest, install, check };
    const registry = new Registry([], path.join(directory, "registry.json"), options);
    registry.register(["cursor"]);
    registry.write("db", "db-one", { command: "npx", args: ["-y", "@akms/mcp-db"], env: { DB_PASSWORD: "private-value" } });
    registry.write("db", "db-two", { command: "npx", args: ["-y", "@akms/mcp-db"], env: { DB_PASSWORD: "private-value" } });
    registry.write("ssh", "ssh-one", { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: { SSH_HOST: "fixture.invalid" } });
    return { registry, options, installed, latest, install, check };
}
describe("Updates menu", () => {
    it("does no latest lookup when building or opening the ordinary config menu", () => {
        const values = fixture();
        const management = new ManagedSession({ kind: "db", targets: [], registryPath: values.registry.file, runtimeOptions: values.options });
        expect(management.items().some(item => "value" in item && item.value === "updates")).toBe(true);
        expect(values.latest).not.toHaveBeenCalled();
    });
    it("lists installed/latest versions and statuses, queries once, and never offers a development link update", async () => {
        const values = fixture();
        const text = await screen(["b"], values.registry);
        for(const status of ["Update available", "Up to date", "Not installed"]) expect(text).toContain(status);
        if(process.platform === "win32") { expect(text).toContain("Development link"); expect(text).not.toContain("Update @akms/mcp-wsl"); }
        expect(values.latest).toHaveBeenCalledTimes(process.platform === "win32" ? 4 : 3);
        expect(values.install).not.toHaveBeenCalled(); expect(text).not.toContain("\u001b");
    });
    it("updates one kind, checks saved entries once per identical command/env and preserves saved values", async () => {
        const values = fixture(); const before = fs.readFileSync(values.registry.file, "utf8");
        const text = await screen(["db", "y", "b"], values.registry);
        expect(values.install).toHaveBeenCalledExactlyOnceWith("db");
        expect(values.check).toHaveBeenCalledTimes(1);
        expect(values.check).toHaveBeenCalledWith(values.registry.read().connections["db-one"].entry);
        expect(text).toContain("OK db-one: fixture@2.0.0, 3 tools"); expect(text).toContain("OK db-two:");
        expect(text).toContain("Reconnect or restart"); expect(fs.readFileSync(values.registry.file, "utf8")).toBe(before);
        expect(values.latest).toHaveBeenCalledTimes(process.platform === "win32" ? 4 : 3);
    });
    it("updates all eligible installed kinds sequentially, continues after a failure and masks diagnostics", async () => {
        const values = fixture(); values.installed.ssh!.version = "1.0.0";
        const order: string[] = [];
        values.options.install = vi.fn(async kind => { order.push(kind); if(kind === "db") throw new Error("fixture private-value"); values.installed[kind]!.version = "2.0.0"; });
        const text = await screen(["a", "y", "b"], values.registry);
        expect(order).toEqual(["db", "ssh"]); expect(values.check).toHaveBeenCalledTimes(1);
        expect(text).toContain("FAILED @akms/mcp-db:"); expect(text).not.toContain("private-value");
        expect(text).toContain("Installed @akms/mcp-ssh 2.0.0"); expect(values.installed.s3).toBeUndefined();
    });
    it("keeps offline lookups unavailable without offering installs or updates", async () => {
        const values = fixture(); values.options.latest = vi.fn(async () => { throw new Error("offline"); });
        const text = await screen(["b"], values.registry);
        expect(text).toContain("Unavailable"); expect(text).toContain("latest: unavailable");
        expect(text).not.toContain("Update all available"); expect(text).not.toContain("Install @akms");
        expect(values.install).not.toHaveBeenCalled();
    });
    it.each(["EBUSY", "EPERM", "EACCES"])("asks users to close AI clients before retrying an npm %s failure", async code => {
        const values = fixture(); values.options.install = vi.fn(async () => { throw new Error(`npm ${code}: fixture file is locked`); });
        const text = await screen(["db", "y", "b"], values.registry);
        expect(text).toContain(code); expect(text).toContain("Close your AI clients, then retry");
        expect(values.check).not.toHaveBeenCalled();
    });
    it("hides WSL on non-Windows systems, including its version query", async () => {
        const values = fixture(); vi.stubGlobal("process", { ...process, platform: "linux" });
        const text = await screen(["b"], values.registry);
        expect(text).not.toContain("mcp-wsl"); expect(values.latest.mock.calls.map(call => call[0])).toEqual(["db", "ssh", "s3"]);
    });
    it("only rechecks versions on explicit Refresh and does not install after No", async () => {
        const values = fixture(); await screen(["db", "n", "r", "b"], values.registry);
        expect(values.latest).toHaveBeenCalledTimes((process.platform === "win32" ? 4 : 3) * 2);
        expect(values.install).not.toHaveBeenCalled();
    });
    it("queries npm with bounded fresh metadata and treats errors, invalid output and timeouts as unavailable", async () => {
        const npm = path.join(directory, "npm-cli.js"), calls = path.join(directory, "npm-calls.json");
        fs.writeFileSync(path.join(directory, "package.json"), '{"type":"commonjs"}');
        fs.writeFileSync(npm, `require('fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify('3.4.5'));`);
        vi.stubEnv("npm_execpath", npm);
        expect(await latestRuntimeVersion("db")).toBe("3.4.5");
        expect(JSON.parse(fs.readFileSync(calls, "utf8"))).toEqual(["view", "@akms/mcp-db@latest", "version", "--json", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=4000"]);
        for(const code of ["process.exit(1)", "process.stdout.write('not json')", "setInterval(() => {}, 1000)"]) {
            fs.writeFileSync(npm, code); expect(await latestRuntimeVersion("db", 300)).toBeNull();
        }
    });
});
