import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, entryHash } from "../src/modules/registration/registry";
import { readCatalog, maxConnectionNameLength, sessionToolName } from "../src/modules/registration/catalog";
import { runtimeMenu } from "../src/modules/registration/runtime-menu";
import { ManagedSession, registrationMenu, syncMenu } from "../src/modules/registration/menu";
import { Prompter } from "../src/modules/registration/prompter";
import type { ConfigTarget, McpKind, McpServerEntry } from "../src/modules/registration/types";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-session-")); vi.stubEnv("AKMS_MCP_HOME", path.join(directory, "catalog")); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if(path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("akms-session-")) throw new Error("Unexpected cleanup target"); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const entry = (kind: McpKind = "db", password = "private-original"): McpServerEntry => ({ command: "npx", args: ["-y", `@akms/mcp-${kind}`], env: { [`${kind.toUpperCase()}_PASSWORD`]: password, [`${kind.toUpperCase()}_DESCRIPTION`]: "fixture description" } });
function fixture({ legacy = true, populate = true } = {}) {
    const targets: ConfigTarget[] = ["cursor", "codex"].map(id => {
        const file = path.join(directory, id + ".json");
        const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, McpServerEntry> : {};
        return { id: id as "cursor" | "codex", label: id, location: file, detected: true, readEntries: read,
            writeEntry: vi.fn((name, value) => { fs.writeFileSync(file, JSON.stringify({ ...read(), [name]: value })); return { status: "written" as const, detail: file }; }),
            removeEntry: vi.fn(name => { const values = read(); delete values[name]; fs.writeFileSync(file, JSON.stringify(values)); return { status: "written" as const, detail: file }; }) };
    });
    const options: Registry["runtimeOptions"] = {
        find: kind => ({ command: process.execPath, args: [path.join(directory, "node_modules/@akms", `mcp-${kind}`, "lib/cli.js")], version: "2.0.0", linked: false }),
        check: vi.fn(async () => ({ ok: true, server: "fixture", version: "2.0.0", tools: 3, toolNames: ["first__db_query", "second__db_query", "db_catalog_status"], exitCode: 0, stderr: [] })),
    };
    const registry = new Registry(targets, path.join(directory, "catalog/registry.json"), options);
    if(legacy) {
        fs.mkdirSync(path.dirname(registry.file), { recursive: true });
        fs.writeFileSync(registry.file, JSON.stringify({ version: 1, clients: [], connections: {} }));
    }
    if(populate) { registry.register(["cursor", "codex"]); registry.write("db", "first", entry()); registry.write("db", "second", entry("db", "private-second")); }
    return { registry, targets, options, backup: path.join(directory, "catalog/registry.previous.json") };
}
async function screen(lines: string[], action: (prompter: Prompter) => Promise<unknown>) {
    const input = new PassThrough(), output = new PassThrough(); let text = "";
    output.on("data", chunk => { text += chunk; }); input.end(lines.join("\n") + "\n");
    const prompter = new Prompter(input, output);
    try { await action(prompter); } finally { prompter.close(); }
    return text;
}

describe("catalog reader contract", () => {
    it.each([1, 2])("reads version %s without locking and preserves description/env values", version => {
        const file = path.join(directory, "registry.json");
        fs.writeFileSync(file, JSON.stringify({ version, connections: { first: { kind: "db", entry: entry() }, gone: { kind: "db", entry: null }, ssh: { kind: "ssh", entry: entry("ssh") } } }));
        const before = fs.readFileSync(file, "utf8");
        const result = readCatalog("db", file);
        expect(result).toEqual({ file, connections: [{ name: "first", env: entry().env }], problems: [] });
        expect(fs.readFileSync(file, "utf8")).toBe(before); expect(fs.existsSync(file + ".lock")).toBe(false);
    });
    it("reports missing, corrupt, unknown-version and malformed entries without secrets or exceptions", () => {
        const file = path.join(directory, "registry.json");
        expect(readCatalog("db", file).problems).toHaveLength(1);
        for(const text of ["private-secret not JSON", JSON.stringify({ version: 99, connections: {} }), JSON.stringify({ version: 2, connections: { private_secret_name: { kind: "db", entry: { env: { DB_PASSWORD: 42 } } }, good: { kind: "db", entry: entry() } } })]) {
            fs.writeFileSync(file, text); const result = readCatalog("db", file);
            expect(result.problems.length).toBeGreaterThan(0); expect(result.problems.join(" ")).not.toContain("private");
            if(text.includes('"good"')) expect(result.connections.map(item => item.name)).toEqual(["good"]);
        }
    });
});

describe("new catalog defaults", () => {
    it("requires Register before the first Add without creating a catalog or client entries", () => {
        const { registry, targets } = fixture({ legacy: false, populate: false });
        expect(() => registry.write("db", "fresh", entry())).toThrow(/Register at least/);
        expect(fs.existsSync(registry.file)).toBe(false); for(const target of targets) expect(target.readEntries()).toEqual({});
    });
    it("writes credential-free default-location session entries without AKMS_MCP_HOME", () => {
        const { targets, options } = fixture({ legacy: false, populate: false });
        vi.stubEnv("AKMS_MCP_HOME", ""); vi.spyOn(os, "homedir").mockReturnValue(directory);
        const registry = new Registry(targets, undefined, options); registry.register(["cursor"]); registry.target("db").writeEntry("fresh", entry());
        expect(registry.read().version).toBe(2); expect(targets[0].readEntries().akms_db.env).toEqual({});
    });
    it.each(["db", "ssh", "wsl", "s3"] as const)("starts fresh Register and Add in v2 session mode for %s", async kind => {
        const { registry, targets, options } = fixture({ legacy: false, populate: false });
        expect(registry.read()).toEqual({ version: 2, defaultMode: "catalog", clients: [], connections: {}, sessions: {} });
        expect(fs.existsSync(registry.file)).toBe(false);
        await screen(["cursor", "codex", "a", "y"], prompter => registrationMenu(prompter, registry));
        expect(registry.read().version).toBe(2); expect(registry.isSessionMode(kind)).toBe(true);
        for(const target of targets) expect(target.readEntries()).toEqual({});
        const managed = new ManagedSession({ kind, targets, registryPath: registry.file, runtimeOptions: options });
        const original = entry(kind); managed.target.writeEntry("fresh", original);
        const state = registry.read(); expect(state.sessions?.[kind]?.mode).toBe("catalog");
        for(const target of targets) {
            const entries = target.readEntries(); expect(Object.keys(entries)).toEqual([`akms_${kind}`]);
            expect(entries[`akms_${kind}`]).toEqual({ command: process.execPath, args: [...options.find!(kind)!.args, "--catalog"], env: { AKMS_MCP_HOME: path.dirname(registry.file) } });
            expect(JSON.stringify(entries)).not.toContain("private-original");
        }
        expect(readCatalog(kind, registry.file).connections).toEqual([{ name: "fresh", env: original.env }]);
        for(const target of targets) vi.mocked(target.writeEntry).mockClear();
        managed.target.writeEntry("another", entry(kind, "private-next"));
        for(const target of targets) expect(target.writeEntry).not.toHaveBeenCalled();
    });
    it("imports existing entries during fresh Register directly into a session and backfills a new service", () => {
        const { registry, targets } = fixture({ legacy: false, populate: false }); targets[0].writeEntry("existing", entry());
        const plan = registry.planRegistration(["cursor"]); expect(plan.imports).toHaveLength(1);
        registry.register(["cursor"], [], plan.imports);
        expect(Object.keys(targets[0].readEntries())).toEqual(["akms_db"]);
        expect(registry.read().connections.existing.entry).toEqual(entry());
        registry.register(["cursor", "codex"]); expect(targets[1].readEntries()).toEqual(targets[0].readEntries());
    });
    it("preserves imported legacy entries while a runtime is missing and applies the session after installation", async () => {
        const { registry, targets, options } = fixture({ legacy: false, populate: false });
        const find = options.find!; options.find = () => null; targets[0].writeEntry("existing", entry());
        const result = registry.register(["cursor"], [], registry.planRegistration(["cursor"]).imports);
        expect(registry.read().version).toBe(2); expect(result.some(row => row.name === "akms_db" && row.status === "pending")).toBe(true);
        expect(registry.kindForName("akms_db")).toBe("db"); expect(targets[0].readEntries()).toEqual({ existing: entry() });
        const text = await screen([], prompter => registry.checkSaved(prompter, ["existing"])); expect(text).toContain("install its runtime"); expect(options.check).not.toHaveBeenCalled();
        options.find = find; registry.sync();
        expect(Object.keys(targets[0].readEntries())).toEqual(["akms_db"]); expect(registry.inspect().every(row => row.status === "synced")).toBe(true);
    });
    it("keeps a fresh catalog's rollback choice while new kinds continue using sessions", () => {
        const { registry, targets } = fixture({ legacy: false }); registry.applySession(registry.planSession("db", "individual"));
        registry.write("db", "third", entry()); registry.write("ssh", "host", entry("ssh"));
        expect(registry.isSessionMode("db")).toBe(false); expect(registry.isSessionMode("ssh")).toBe(true);
        expect(Object.keys(targets[0].readEntries()).sort()).toEqual(["akms_ssh", "first", "second", "third"]);
    });
    it("keeps an older v2 catalog's absent kind in individual mode", () => {
        const { registry, targets } = fixture(); registry.applySession(registry.planSession("db", "catalog"));
        expect(registry.read().defaultMode).toBeUndefined(); registry.write("ssh", "host", entry("ssh"));
        expect(registry.isSessionMode("ssh")).toBe(false); expect(targets[0].readEntries().host).toEqual(entry("ssh"));
    });
});

describe("registry v2 session migration", () => {
    it("uses an empty session environment at the default catalog location", () => {
        const { registry, options } = fixture();
        vi.stubEnv("AKMS_MCP_HOME", ""); vi.spyOn(os, "homedir").mockReturnValue(directory);
        const defaultRegistry = new Registry(registry.targets, path.join(directory, ".akms/mcp/registry.json"), options);
        expect(defaultRegistry.sessionEntry("db").env).toEqual({});
    });
    it("backfills and unregisters sessions while preserving other kinds", () => {
        const { registry, targets } = fixture(); registry.write("ssh", "host", entry("ssh"));
        registry.applySession(registry.planSession("db", "catalog"));
        registry.register(["codex"]);
        expect(targets[0].readEntries()).toEqual({});
        expect(Object.keys(targets[1].readEntries()).sort()).toEqual(["akms_db", "host"]);
        registry.register(["cursor", "codex"]);
        expect(targets[0].readEntries()).toEqual(targets[1].readEntries());
        expect(registry.isSessionMode("ssh")).toBe(false);
    });
    it("keeps unmanaged session name collisions and legacy entries until the collision is resolved", () => {
        const { registry, targets } = fixture();
        const external = { command: "another-server", args: [], env: {} }; targets[0].writeEntry("akms_db", external);
        expect(registry.planSession("db", "catalog").changes[0].review).toContain("akms_db");
        registry.applySession(registry.planSession("db", "catalog"));
        expect(targets[0].readEntries()).toEqual({ first: entry(), second: entry("db", "private-second"), akms_db: external });
        targets[0].removeEntry("akms_db"); registry.sync();
        expect(Object.keys(targets[0].readEntries())).toEqual(["akms_db"]);
    });
    it("fails before changing the catalog or clients if the previous revision cannot be committed", () => {
        const { registry, targets, backup } = fixture();
        const before = fs.readFileSync(registry.file, "utf8"), client = targets[0].readEntries(), previous = fs.readFileSync(backup, "utf8");
        const rename = fs.renameSync; vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
            if(to === backup) throw new Error("fixture backup write failure"); rename(from, to);
        });
        expect(() => registry.applySession(registry.planSession("db", "catalog"))).toThrow(/backup write failure/);
        expect(fs.readFileSync(registry.file, "utf8")).toBe(before); expect(fs.readFileSync(backup, "utf8")).toBe(previous);
        expect(targets[0].readEntries()).toEqual(client); expect(fs.existsSync(registry.file + ".lock")).toBe(false);
        expect(fs.readdirSync(path.dirname(registry.file)).sort()).toEqual(["registry.json", "registry.previous.json"]);
    });
    it("lets Sync remove a renamed legacy entry once the catalog session exists", async () => {
        const { registry, targets } = fixture(); const external = entry("db", "private-external"); targets[0].writeEntry("first", external);
        registry.applySession(registry.planSession("db", "catalog")); registry.write("db", "renamed", entry(), "first");
        const text = await screen(["1", "shared", "y"], prompter => syncMenu(prompter, registry));
        expect(text).toContain("individual client entry is no longer needed");
        expect(targets[0].readEntries().first).toBeUndefined(); expect(registry.read().connections.first).toBeUndefined();
        expect(registry.read().connections.renamed.entry).toEqual(entry());
    });
    it("lets Sync restore an external session launch only after explicit confirmation", async () => {
        const { registry, targets } = fixture(); registry.applySession(registry.planSession("db", "catalog"));
        const expected = targets[0].readEntries().akms_db, external = { ...expected, args: [...expected.args, "--external"] };
        targets[0].writeEntry("akms_db", external);
        await screen(["1", "1", "", "b"], prompter => syncMenu(prompter, registry)); expect(targets[0].readEntries().akms_db).toEqual(external);
        const text = await screen(["1", "1", "y"], prompter => syncMenu(prompter, registry));
        expect(text).toContain("Restore the AKMS session launch"); expect(targets[0].readEntries().akms_db).toEqual(expected);
    });
    it("previews v1, migrates each client without credentials, then restores original individual entries", () => {
        const { registry, targets, backup } = fixture();
        const old = fs.readFileSync(registry.file, "utf8"), original = targets[0].readEntries();
        const plan = registry.planSession("db", "catalog");
        expect(registry.read().version).toBe(1); expect(fs.readFileSync(registry.file, "utf8")).toBe(old);
        expect(plan.changes[0]).toMatchObject({ add: ["akms_db"], remove: ["first", "second"], review: [] });
        registry.applySession(plan);
        expect(fs.readFileSync(backup, "utf8")).toBe(old);
        expect(registry.read().version).toBe(2); expect(registry.isSessionMode("db")).toBe(true);
        for(const target of targets) {
            const entries = target.readEntries(); expect(Object.keys(entries)).toEqual(["akms_db"]);
            expect(entries.akms_db.args.at(-1)).toBe("--catalog"); expect(entries.akms_db.env).toEqual({ AKMS_MCP_HOME: path.dirname(registry.file) });
            expect(JSON.stringify(entries)).not.toContain("private-");
        }
        expect(registry.candidates().entries).toEqual([]);
        const bundled = fs.readFileSync(registry.file, "utf8");
        registry.applySession(registry.planSession("db", "individual"));
        expect(registry.read().version).toBe(2); expect(registry.isSessionMode("db")).toBe(false);
        for(const target of targets) expect(target.readEntries()).toEqual(original);
        expect(fs.readFileSync(backup, "utf8")).toBe(bundled);
    });
    it("changes only catalog data on Add/Edit until the last connection removes the session entry", () => {
        const { registry, targets } = fixture(); registry.applySession(registry.planSession("db", "catalog"));
        for(const target of targets) { vi.mocked(target.writeEntry).mockClear(); vi.mocked(target.removeEntry).mockClear(); }
        const bundle = targets[0].readEntries().akms_db;
        registry.write("db", "first", entry("db", "private-edited")); registry.write("db", "third", entry()); registry.remove("db", "second");
        for(const target of targets) { expect(target.writeEntry).not.toHaveBeenCalled(); expect(target.removeEntry).not.toHaveBeenCalled(); }
        expect(targets[0].readEntries().akms_db).toEqual(bundle);
        registry.remove("db", "first"); registry.remove("db", "third");
        for(const target of targets) expect(target.readEntries()).toEqual({});
        registry.write("db", "new_one", entry()); expect(targets[0].readEntries().akms_db).toEqual(bundle);
    });
    it("retains one pre-action revision across internal bookkeeping and supports recovery after deletion", () => {
        const { registry, backup } = fixture(); registry.applySession(registry.planSession("db", "catalog"));
        const before = fs.readFileSync(registry.file, "utf8");
        registry.write("db", "first", entry("db", "private-edited"));
        expect(fs.readFileSync(backup, "utf8")).toBe(before);
        registry.sync(); expect(fs.readFileSync(backup, "utf8")).toBe(before);
        expect(fs.readdirSync(path.dirname(registry.file)).sort()).toEqual(["registry.json", "registry.previous.json"]);
        fs.unlinkSync(registry.file); expect(readCatalog("db", registry.file).connections).toEqual([]);
        fs.copyFileSync(backup, registry.file); expect(readCatalog("db", registry.file).connections[0].env.DB_PASSWORD).toBe("private-original");
    });
    it("preserves externally edited legacy entries for Sync and can import their changes before removal", () => {
        const { registry, targets } = fixture(); const external = entry("db", "private-external"); targets[0].writeEntry("first", external);
        const plan = registry.planSession("db", "catalog"); expect(plan.changes[0].review).toContain("first");
        expect(registry.applySession(plan).some(row => row.name === "first" && row.client === "cursor" && row.status === "conflict")).toBe(true);
        expect(targets[0].readEntries().first).toEqual(external); expect(targets[1].readEntries().first).toBeUndefined();
        registry.resolve("cursor", "first", external, true);
        expect(targets[0].readEntries().first).toBeUndefined(); expect(registry.read().connections.first.entry).toEqual(external);
    });
    it("preserves external session edits on sync and rollback until explicitly reviewed", () => {
        const { registry, targets } = fixture(); registry.applySession(registry.planSession("db", "catalog"));
        const external = { ...targets[0].readEntries().akms_db, args: [...targets[0].readEntries().akms_db.args, "--external"] };
        targets[0].writeEntry("akms_db", external);
        expect(registry.sync().some(row => row.name === "akms_db" && row.status === "conflict")).toBe(true);
        registry.applySession(registry.planSession("db", "individual"));
        expect(targets[0].readEntries().akms_db).toEqual(external); expect(targets[0].readEntries().first).toEqual(entry());
        registry.resolve("cursor", "akms_db", external, false); expect(targets[0].readEntries().akms_db).toBeUndefined();
    });
    it("keeps the old representation until its replacements are verified on each service", () => {
        const { registry, targets } = fixture(); const write = targets[0].writeEntry;
        targets[0].writeEntry = (name, value) => name === "akms_db" ? { status: "unavailable", detail: "fixture failure" } : write(name, value);
        registry.applySession(registry.planSession("db", "catalog"));
        expect(targets[0].readEntries().first).toEqual(entry()); expect(Object.keys(targets[1].readEntries())).toEqual(["akms_db"]);
        targets[0].writeEntry = write; registry.sync();
        targets[0].writeEntry = (name, value) => name === "first" ? { status: "unavailable", detail: "fixture failure" } : write(name, value);
        registry.applySession(registry.planSession("db", "individual")); expect(targets[0].readEntries().akms_db).toBeDefined();
        targets[0].writeEntry = write; registry.sync(); expect(targets[0].readEntries().akms_db).toBeUndefined();
    });
    it("rejects stale previews and unknown or malformed v2 files without changing clients or backup", () => {
        const { registry, targets, backup } = fixture(); const plan = registry.planSession("db", "catalog");
        registry.write("db", "third", entry()); expect(() => registry.applySession(plan)).toThrow(/changed since review/);
        const client = fs.readFileSync(targets[0].location, "utf8"), prior = fs.readFileSync(backup, "utf8");
        for(const state of [{ version: 3 }, { version: 2, clients: [], connections: {}, sessions: {}, defaultMode: "invalid" }, { version: 2, clients: [], connections: {}, sessions: { db: { mode: "catalog", entry: entry(), applied: {} } } }]) {
            fs.writeFileSync(registry.file, JSON.stringify(state)); expect(() => registry.sync()).toThrow();
            expect(fs.readFileSync(backup, "utf8")).toBe(prior); expect(fs.readFileSync(targets[0].location, "utf8")).toBe(client);
        }
    });
    it.each(["db", "ssh", "wsl", "s3"] as const)("enforces the full 64-character tool name budget for %s when saving", kind => {
        const { registry } = fixture(); const length = maxConnectionNameLength(kind), name = "x".repeat(length);
        registry.write(kind, name, entry(kind)); expect(registry.read().connections[name].entry).toEqual(entry(kind));
        expect(() => registry.write(kind, name + "x", entry(kind))).toThrow(/Connection names/);
        expect(() => registry.write(kind, `akms_${kind}`, entry(kind))).toThrow(/reserved/);
        const longest = { db: "db_list_hosts", ssh: "ssh_list_sessions", wsl: "wsl_list_sessions", s3: "s3_download" }[kind];
        expect(`mcp__akms_${kind}__${sessionToolName(name, longest)}`).toHaveLength(64);
    });
    it("previews the Runtime switch, defaults to No and checks every connection prefix after approval", async () => {
        const { registry, targets, options } = fixture();
        await screen(["catalog", "", "b"], prompter => runtimeMenu(prompter, registry, "db")); expect(registry.read().version).toBe(1);
        const text = await screen(["catalog", "y", "b"], prompter => runtimeMenu(prompter, registry, "db"));
        expect(text).toContain("Apply: akms_db"); expect(text).toContain("OK akms_db: fixture@2.0.0");
        expect(options.check).toHaveBeenCalledExactlyOnceWith(targets[0].readEntries().akms_db);
        expect(text).not.toContain("private-original");
        options.check = vi.fn(async () => ({ ok: true, exitCode: 0, server: "fixture", version: "2.0.0", tools: 1, toolNames: ["first__db_query"], stderr: ["private-second"] }));
        const failed = await screen([], prompter => registry.checkSaved(prompter, ["first"]));
        expect(failed).toContain("Missing connection tools: second"); expect(failed).not.toContain("private-second"); expect(failed).toContain("Settings remain saved.");
        expect(entryHash(targets[0].readEntries().akms_db)).toBe(entryHash(registry.read().sessions!.db!.entry));
    });
    it("does not count a longer connection prefix as proof that a missing shorter connection loaded", async () => {
        const { registry, options } = fixture(); registry.remove("db", "second"); registry.write("db", "first__nested", entry());
        registry.applySession(registry.planSession("db", "catalog"));
        options.check = vi.fn(async () => ({ ok: true, exitCode: 0, server: "fixture", version: "2.0.0", tools: 1, toolNames: ["first__nested__db_query"], stderr: [] }));
        const text = await screen([], prompter => registry.checkSaved(prompter, ["first"]));
        expect(text).toContain("Missing connection tools: first."); expect(text).not.toContain("Missing connection tools: first__nested");
    });
});
