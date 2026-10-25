import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkStartup, checkConnections, redactStartupText } from "../src/modules/registration/startup-check";
import { Prompter } from "../src/modules/registration/prompter";
import type { McpServerEntry } from "../src/modules/registration/types";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms startup ")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(mode = "ok"): McpServerEntry {
    const file = path.join(directory, "fixture server.cjs");
    fs.writeFileSync(file, `
const fs = require('node:fs');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
if(process.env.MODE === 'timeout' || process.env.MODE === 'tree') {
  if(process.env.MODE === 'tree') {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {windowsHide: true, stdio: 'inherit'});
    fs.writeFileSync(process.env.PID_FILE + '.child', String(child.pid));
  }
  setInterval(() => {}, 1000); process.stdin.resume();
}
else if(process.env.MODE === 'failure') {
  process.stderr.write('old1\\nold2\\n3\\n4\\n5\\npassword=' + process.env.DB_PASSWORD + '\\nurl password=decoded-pass\\n\\x1b[31marg=' + process.argv[3] + '\\x1b[0m\\n'); process.exit(7);
} else {
  require('node:readline').createInterface({input: process.stdin}).on('line', line => {
    const m = JSON.parse(line); fs.appendFileSync(process.env.CALLS_FILE, m.method + '\\n');
    if(!m.id) return;
    const result = m.method === 'initialize'
      ? {protocolVersion: process.env.MODE === 'future' ? '2099-01-01' : m.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1.2.3'}}
      : {tools: [{name: 'fixture_tool'}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result}) + '\\n');
  });
  process.stdin.on('end', () => fs.appendFileSync(process.env.CALLS_FILE, 'stdin-closed\\n'));
}
`);
    return { command: process.execPath, args: [file, "literal;&argument", "argument-secret"], env: {
        MODE: mode, PID_FILE: path.join(directory, "pid"), CALLS_FILE: path.join(directory, "calls"), DB_PASSWORD: "private-password", DB_URL: "postgres://user:decoded-pass@fixture/db",
    } };
}
async function screen(entries: { name: string; entry: McpServerEntry }[], check = checkStartup) {
    const input = new PassThrough(), output = new PassThrough(); let text = "";
    output.on("data", chunk => { text += chunk; }); input.end();
    const prompter = new Prompter(input, output);
    try { await checkConnections(prompter, entries, check); } finally { prompter.close(); }
    return text;
}
describe("startup check without remote tool calls", () => {
    it("masks URL passwords embedded in flags and values interrupted by terminal controls", () => {
        const entry = { command: "node", args: ["--url=postgres://user:flag-password@fixture/db"], env: { DB_PASSWORD: "private-value" } };
        expect(redactStartupText("flag-password private-\u001b[31mvalue", entry)).toBe("(hidden) (hidden)");
    });
    it("initializes, lists tools, closes stdin and waits for process exit with literal args", async () => {
        const entry = fixture();
        expect(await checkStartup(entry)).toMatchObject({ ok: true, server: "fixture", version: "1.2.3", tools: 1, exitCode: 0 });
        expect(fs.readFileSync(entry.env.CALLS_FILE, "utf8")).toBe("initialize\nnotifications/initialized\ntools/list\nstdin-closed\n");
        const pid = Number(fs.readFileSync(entry.env.PID_FILE));
        expect(() => process.kill(pid, 0)).toThrow();
    });
    it("reports missing executable and missing script failures", async () => {
        const entry = fixture();
        const missing = await checkStartup({ ...entry, command: path.join(directory, "missing-command") });
        expect(missing).toMatchObject({ ok: false, exitCode: null }); expect(missing.detail).toContain("ENOENT");
        expect(missing.detail).toContain(path.join(directory, "missing-command"));
        const script = await checkStartup({ ...entry, args: [path.join(directory, "missing.js")] });
        expect(script).toMatchObject({ ok: false, exitCode: 1 }); expect(script.stderr.length).toBeGreaterThan(0);
    });
    it("keeps the standard runtime path visible while masking custom arguments", async () => {
        const file = path.join(directory, "node_modules/@akms/mcp-db/lib/cli.js");
        const entry = { command: process.execPath, args: [file], env: { DB_PASSWORD: "private-secret" } };
        const result = await checkStartup(entry);
        expect(result.detail).toContain(file);
        expect(redactStartupText(file + " private-secret", entry)).toBe(file + " (hidden)");
        expect(redactStartupText(file, { ...entry, args: [file, "--private"] })).toBe("(hidden)");
    });
    it("accepts a newer protocol version string from the server", async () => {
        expect((await checkStartup(fixture("future"))).ok).toBe(true);
    });
    it("times out and reaps the fixture instead of leaving an idle MCP", async () => {
        const entry = fixture("timeout");
        const start = Date.now(); const result = await checkStartup(entry, 300);
        expect(result.ok).toBe(false); expect(result.detail).toContain("Timed out");
        expect(Date.now() - start).toBeLessThan(6000);
        expect(() => process.kill(Number(fs.readFileSync(entry.env.PID_FILE)), 0)).toThrow();
    }, 8000);
    it.runIf(process.platform === "win32")("terminates the spawned process tree on a Windows timeout", async () => {
        const entry = fixture("tree");
        expect((await checkStartup(entry, 500)).ok).toBe(false);
        for(const file of [entry.env.PID_FILE, entry.env.PID_FILE + ".child"]) expect(() => process.kill(Number(fs.readFileSync(file)), 0)).toThrow();
    }, 8000);
    it("masks secret env values, URL passwords and arguments before retaining stderr tail", async () => {
        const entry = fixture("failure");
        const result = await checkStartup(entry);
        expect(result).toMatchObject({ ok: false, exitCode: 7 });
        expect(result.stderr).toHaveLength(6);
        const text = await screen([{ name: "fixture", entry }], async () => result);
        for(const secret of ["private-password", "decoded-pass", "argument-secret", "old1", "old2", "\u001b"]) expect(text).not.toContain(secret);
        expect(text).toContain("(hidden)"); expect(text).toContain("exit 7");
        expect(text).toContain("Settings remain saved."); expect(text).toContain("before restarting");
    });
    it("runs identical entries once while reporting every name in plain piped output", async () => {
        const entry = fixture();
        const check = vi.fn(checkStartup);
        const text = await screen([{ name: "first", entry }, { name: "second", entry: { ...entry, env: Object.fromEntries(Object.entries(entry.env).reverse()) } }], check);
        expect(check).toHaveBeenCalledTimes(1);
        expect(text).toContain("OK first: fixture@1.2.3, 1 tools"); expect(text).toContain("OK second:");
        expect(text).not.toContain("\u001b");
    });
});
