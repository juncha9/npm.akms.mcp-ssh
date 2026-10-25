import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigTarget, McpServerEntry } from "@/_types";

vi.mock("node:child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("node:child_process")>(),
    spawnSync: vi.fn(),
}));
vi.mock("@/_libs", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/_libs")>(),
    findExecutable: vi.fn(() => "test-claude.exe"),
}));

const ENTRY: McpServerEntry = { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: { SSH_HOST: "saved-value", SECRET: "sensitive-value" } };
const OLD_HTTP = { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer old-value" } };
let directory: string;
let configPath: string;
let target: ConfigTarget;

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ssh-targets-"));
    vi.spyOn(os, "homedir").mockReturnValue(directory);
    vi.resetModules();
    vi.mocked(spawnSync).mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
});

function result(status: number) {
    return { status, signal: null, error: undefined, stdout: "", stderr: status ? "test failure" : "", pid: 1, output: [] };
}

describe("copying to Codex TOML", () => {
    beforeEach(async () => {
        const { createCodexTarget } = await import("@/modules/manage/targets/codex");
        target = createCodexTarget();
        configPath = path.join(directory, ".codex", "config.toml");
        expect(target.location).toBe(configPath);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
    });

    it.each(["connection", '"connection"', "'connection'"])("detects and replaces an HTTP entry named %s, preserving unrelated config", (tableName) => {
        const other = 'model = "test-model"\n\n[mcp_servers.docs]\nurl = "https://example.invalid/docs"\n';
        fs.writeFileSync(configPath, `${other}\n[mcp_servers.${tableName}]\nurl = "https://example.invalid/old"\n\n[mcp_servers.${tableName}.http_headers]\nAuthorization = "old-value"\n`);
        expect(target.readEntries().connection).toBeUndefined();
        expect(target.hasEntry?.("connection")).toBe(true);
        expect(target.writeEntry("connection", ENTRY, { replace: true }).status).toBe("written");
        expect(target.readEntries().connection).toEqual(ENTRY);
        const updated = fs.readFileSync(configPath, "utf8");
        expect(updated).toContain(other);
        expect(updated).not.toContain("example.invalid/old");
        expect(updated).not.toContain("http_headers");
        expect(updated).not.toContain("old-value");
    });

    it("asks before overwriting a TOML entry omitted from the stdio list", async () => {
        const before = '[mcp_servers.connection]\nurl = "https://example.invalid/mcp"\n';
        fs.writeFileSync(configPath, before);
        const { copyEntryToClient } = await import("@/modules/manage/copy-entry");
        const { Prompter } = await import("@/modules/manage/prompter");
        const input = new PassThrough();
        const output = new PassThrough();
        let screen = "";
        output.on("data", (chunk: Buffer) => { screen += chunk.toString(); });
        input.end("codex\nn\n");
        const prompter = new Prompter(input, output);
        try {
            const source = { ...target, id: "cursor" as const, label: "Cursor" };
            await copyEntryToClient(prompter, source, [source, target], "connection", ENTRY);
        }
        finally {
            prompter.close();
        }
        expect(screen).toContain("Overwrite it?");
        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    });

    it("preserves hand-written settings during an ordinary edit", () => {
        fs.writeFileSync(configPath, '[mcp_servers.connection]\ncommand = "old"\nstartup_timeout_sec = 45\n');
        target.writeEntry("connection", ENTRY);
        expect(fs.readFileSync(configPath, "utf8")).toContain("startup_timeout_sec = 45");
    });
});

describe("copying to Claude Code through its CLI", () => {
    beforeEach(async () => {
        const { findExecutable } = await import("@/_libs");
        vi.mocked(findExecutable).mockReturnValue("test-claude.exe");
        const { createClaudeCodeTarget } = await import("@/modules/manage/targets/claude-code");
        target = createClaudeCodeTarget();
        configPath = path.join(directory, ".claude.json");
        expect(target.location).toBe(configPath);
        fs.writeFileSync(configPath, JSON.stringify({ theme: "dark", mcpServers: { connection: OLD_HTTP } }));
    });

    it("recognizes an HTTP name and removes it before adding the copied stdio entry", () => {
        expect(target.hasEntry?.("connection")).toBe(true);
        expect(target.readEntries().connection).toBeUndefined();
        const before = fs.readFileSync(configPath, "utf8");
        vi.mocked(spawnSync).mockReturnValue(result(0));
        expect(target.writeEntry("connection", ENTRY).status).toBe("written");
        expect(vi.mocked(spawnSync).mock.calls.map((call) => call[1])).toEqual([
            ["mcp", "remove", "connection", "-s", "user"],
            ["mcp", "add-json", "connection", JSON.stringify({ type: "stdio", ...ENTRY }), "-s", "user"],
        ]);
        // The adapter must only invoke the CLI; the fake CLI never mutates the file.
        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    });

    it("restores the complete previous HTTP entry when adding the copy fails", () => {
        vi.mocked(spawnSync).mockReturnValueOnce(result(0)).mockReturnValueOnce(result(1)).mockReturnValueOnce(result(0));
        const written = target.writeEntry("connection", ENTRY);
        expect(written.status).toBe("unavailable");
        expect(written.detail).toContain("the previous entry was restored");
        expect(vi.mocked(spawnSync).mock.calls[2][1]).toEqual([
            "mcp", "add-json", "connection", JSON.stringify(OLD_HTTP), "-s", "user",
        ]);
    });

    it("reports recovery failure truthfully", () => {
        vi.mocked(spawnSync).mockReturnValueOnce(result(0)).mockReturnValueOnce(result(1)).mockReturnValueOnce(result(1));
        const written = target.writeEntry("connection", ENTRY);
        expect(written.detail).toContain("could not restore the previous entry");
        expect(written.detail).not.toContain("was restored");
    });

    it("does not attempt an add when removing the conflicting entry fails", () => {
        vi.mocked(spawnSync).mockReturnValue(result(1));
        expect(target.writeEntry("connection", ENTRY).status).toBe("unavailable");
        expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    it("reports a missing CLI without exposing copied credentials", async () => {
        const { findExecutable } = await import("@/_libs");
        vi.mocked(findExecutable).mockReturnValue(null);
        const { createClaudeCodeTarget } = await import("@/modules/manage/targets/claude-code");
        const written = createClaudeCodeTarget().writeEntry("connection", ENTRY);
        expect(written.status).toBe("unavailable");
        expect(written.detail).not.toContain("sensitive-value");
        expect(spawnSync).not.toHaveBeenCalled();
    });
});
