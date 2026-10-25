import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSshCatalogServer as createCatalog } from "../src/server";
import { LONGEST_TOOL_NAME_LENGTH, maxConnectionNameLength } from "../src/modules/registration/catalog";

const kind = "ssh" as const;
const baseTools = ["ssh_list_hosts","ssh_connect","ssh_disconnect","ssh_list_sessions","ssh_exec","ssh_list_dir","ssh_read_file","ssh_write_file","ssh_upload","ssh_download"];
const base: Record<string, string> = {"SSH_HOST":"first.invalid","SSH_USER":"fixture","SSH_PASSWORD":"fixture-private-secret","SSH_DESCRIPTION":"development","SSH_READONLY":"true"};
const secondary: Record<string, string> = {"SSH_HOST":"second.invalid","SSH_DESCRIPTION":"production","SSH_READONLY":"false"};
const bad: Record<string, string> = {"SSH_PORT":"invalid-private-value"};
let directory: string;
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-catalog-ssh-"));
    for(const key of ["DB_MCP_LOG_LEVEL", "SSH_MCP_LOG_LEVEL", "WSL_MCP_LOG_LEVEL"]) vi.stubEnv(key, "silent");
});
afterEach(async () => {
    for(const close of cleanups.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^akms-catalog-ssh-/);
    fs.rmSync(directory, { recursive: true, force: true });
});
function writeCatalog(entries: Record<string, Record<string, string>>) {
    const file = path.join(directory, "registry.json");
    fs.writeFileSync(file, JSON.stringify({ version: 2, clients: [], connections: Object.fromEntries(
        Object.entries(entries).map(([name, env]) => [name, { kind, entry: { command: "node", args: [], env }, applied: {} }])) }));
    return file;
}
async function connect(file: string) {
    const instance = createCatalog(file);
    const client = new Client({ name: "catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(async () => { await client.close().catch(() => {}); await instance.shutdown().catch(() => {}); await instance.server.close().catch(() => {}); });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, instance };
}
async function status(client: Client) {
    const result = await client.callTool({ name: kind + "_catalog_status" });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe("ssh catalog session server", () => {
    it("lists N independent connection tool sets and one status tool within the complete client name budget", async () => {
        const file = writeCatalog({ alpha: base, beta: { ...base, ...secondary } });
        const before = fs.readFileSync(file, "utf8");
        const { client, instance } = await connect(file);
        const tools = (await client.listTools()).tools;
        expect(tools.map(tool => tool.name).sort()).toEqual([
            ...["alpha", "beta"].flatMap(name => baseTools.map(tool => name + "__" + tool)), kind + "_catalog_status",
        ].sort());
        expect(tools.slice(0, baseTools.length).every(tool => tool.name.startsWith("alpha__"))).toBe(true);
        expect(instance.connectionCount).toBe(2);
        expect(new Set(instance.contexts).size).toBe(2);
        const originalNames = tools.filter(tool => tool.name.startsWith("alpha__")).map(tool => tool.name.slice(7));
        expect(Math.max(...originalNames.map(name => name.length))).toBeLessThanOrEqual(LONGEST_TOOL_NAME_LENGTH[kind]);
        for(const tool of tools) {
            expect(("mcp__akms_" + kind + "__" + tool.name).length).toBeLessThanOrEqual(64);
            expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("connection");
        }
        const state = await status(client);
        expect(state.file).toBe(file);
        expect(state.connections.map((item: { name: string; readonly: boolean }) => [item.name, item.readonly])).toEqual([["alpha", true], ["beta", false]]);
        expect(fs.readFileSync(file, "utf8")).toBe(before);
    });
    it("describes the connection prefixes, targets and policies without credential values", async () => {
        const { client } = await connect(writeCatalog({ alpha: base, beta: { ...base, ...secondary } }));
        const instructions = client.getInstructions()!;
        expect(instructions).toContain("alpha__");
        expect(instructions).toContain("development");
        expect(instructions).toContain("production");
        expect(instructions).toContain('"readonly": true');
        expect(instructions).toContain("Choose the intended connection");
        const shown = instructions + JSON.stringify(await status(client));
        expect(shown).not.toContain("fixture-private-secret");
        expect(shown).not.toContain("fixture-access");
        expect(shown).not.toContain("PASSWORD");
    });
    it("isolates invalid profiles and overlong names while serving the valid connection", async () => {
        const long = "x".repeat(maxConnectionNameLength(kind) + 1);
        const { client, instance } = await connect(writeCatalog({ alpha: base, broken: { ...base, ...bad }, [long]: base }));
        expect(instance.connectionCount).toBe(1);
        const state = await status(client);
        expect(state.connections.map((item: { name: string }) => item.name)).toEqual(["alpha"]);
        expect(state.skipped.map((item: { name: string }) => item.name).sort()).toEqual(["broken", long].sort());
        expect(state.skipped.every((item: { reason: string }) => item.reason.length > 0)).toBe(true);
        expect(JSON.stringify(state)).not.toContain("invalid-private-value");
        expect(JSON.stringify(state)).not.toContain("fixture-private-secret");
        expect((await client.listTools()).tools).toHaveLength(baseTools.length + 1);
    });
    it("accepts the exact maximum connection name without truncating it", async () => {
        const name = "a".repeat(maxConnectionNameLength(kind));
        const { client } = await connect(writeCatalog({ [name]: base }));
        const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith(name + "__"));
        expect(tools).toHaveLength(baseTools.length);
        expect(Math.max(...tools.map(tool => ("mcp__akms_" + kind + "__" + tool.name).length))).toBe(64);
    });
    it.each(["missing", "broken"])("starts with only status when the registry is %s", async (mode) => {
        const file = path.join(directory, "registry.json");
        if(mode === "broken") fs.writeFileSync(file, '{"fixture-private-secret": broken JSON');
        const { client, instance } = await connect(file);
        expect(instance.connectionCount).toBe(0);
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([kind + "_catalog_status"]);
        const state = await status(client);
        expect(state.problems.length).toBeGreaterThan(0);
        expect(JSON.stringify(state)).not.toContain("fixture-private-secret");
    });
    it("does not fall back to ambient connection settings for an empty catalog entry", async () => {
        for(const [key, value] of Object.entries(base)) vi.stubEnv(key, value);
        const { client } = await connect(writeCatalog({ empty: {} }));
        expect((await status(client)).connections).toEqual([]);
        expect((await client.listTools()).tools).toHaveLength(1);
    });
    it("takes one snapshot and requires reconnecting to load edits", async () => {
        const file = writeCatalog({ alpha: base });
        const old = await connect(file);
        writeCatalog({ beta: { ...base, ...secondary } });
        expect((await status(old.client)).connections[0].name).toBe("alpha");
        const next = await connect(file);
        expect((await status(next.client)).connections[0].name).toBe("beta");
    });
    it("routes each prefixed host tool to its own target and policy", async () => {
        const { client } = await connect(writeCatalog({ alpha: base, beta: { ...base, ...secondary } }));
        const call = async (name: string) => {
            const result = await client.callTool({ name, arguments: {} });
            expect(result.isError).not.toBe(true);
            return JSON.stringify(result.content);
        };
        const alpha = await call("alpha__ssh_list_hosts");
        const beta = await call("beta__ssh_list_hosts");
        expect(alpha).toContain("first.invalid");
        expect(alpha).not.toContain("second.invalid");
        expect(beta).toContain("second.invalid");
        expect(beta).not.toContain("first.invalid");
        expect(alpha).toMatch(/read.only/i);
        expect(beta).toContain("writable");
    });
    it("closes every connection exactly once", async () => {
        const { instance } = await connect(writeCatalog({ alpha: base, beta: { ...base, ...secondary } }));
        const closed = instance.contexts.map(context => vi.spyOn(context.sessions, "closeAll"));
        await instance.shutdown();
        await instance.shutdown();
        expect(closed).toHaveLength(2);
        for(const close of closed) expect(close).toHaveBeenCalledOnce();
    });
});
