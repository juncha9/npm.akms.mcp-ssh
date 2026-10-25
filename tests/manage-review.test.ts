import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigTarget, McpServerEntry } from "@/_types";
import { hasMcpServerToml, parseMcpServersToml, renderMcpServerTable, writeMcpServerToml } from "@/modules/manage/targets/toml-subset";
import { createJsonFileTarget } from "@/modules/manage/targets/json-file";

const ENTRY: McpServerEntry = { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: { KEY: "new-value" } };
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ssh-review-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe("TOML review regressions", () => {
    it.each(['"""', "'''"])("keeps table-looking lines inside %s strings byte for byte", (quote) => {
        const instructions = `instructions = ${quote}\n[mcp_servers.connection]\nkeep this text # [brackets]\n${quote}\n\n`;
        const before = instructions + '[mcp_servers.connection]\ncommand = "old"\n';
        const replaced = writeMcpServerToml(writeMcpServerToml(before, "connection", null), "connection", ENTRY);
        expect(replaced.startsWith(instructions)).toBe(true);
        expect(parseMcpServersToml(replaced).connection).toEqual(ENTRY);
        expect(hasMcpServerToml(instructions, "connection")).toBe(false);
    });

    it("reads literal keys, multiline env and escaped control characters without dropping data", () => {
        const before = '[mcp_servers.connection]\ncommand = "npx"\nargs = ["-y", "@akms/mcp-ssh"]\n[mcp_servers.connection.env]\n\'KEY\' = """first\nsecond"""\n"ESCAPED" = "a\\bb\\fc"\n';
        const entry = parseMcpServersToml(before).connection;
        expect(entry.env).toEqual({ KEY: "first\nsecond", ESCAPED: "a\bb\fc" });
        expect(parseMcpServersToml(renderMcpServerTable("copy", entry)).copy).toEqual(entry);
    });

    it("replaces quoted top-level tables and multiline owned fields", () => {
        const before = '["mcp_servers".connection]\n\'command\' = """old\ncommand"""\nargs = []\n';
        expect(hasMcpServerToml(before, "connection")).toBe(true);
        expect(parseMcpServersToml(writeMcpServerToml(before, "connection", ENTRY)).connection).toEqual(ENTRY);
    });

    it.each([
        '[mcp_servers]\nconnection = { command = "old" }\n',
        'mcp_servers.connection.command = "old"\n',
    ])("detects unsupported editing layouts and refuses to damage them", (before) => {
        expect(hasMcpServerToml(before, "connection")).toBe(true);
        expect(parseMcpServersToml(before).connection.command).toBe("old");
        expect(() => writeMcpServerToml(before, "connection", null)).toThrow(/Cannot safely edit/);
        expect(() => writeMcpServerToml(before, "connection", ENTRY)).toThrow(/Cannot safely edit/);
    });

    it("rejects invalid input without including credential-bearing lines in the error", () => {
        const invalid = '[mcp_servers.connection]\ncommand = "old"\nsecret = "sensitive-value\n';
        for(const action of [
            () => hasMcpServerToml(invalid, "connection"),
            () => parseMcpServersToml(invalid),
            () => writeMcpServerToml(invalid, "connection", ENTRY),
        ]) {
            expect(action).toThrow(/Invalid TOML/);
            try { action(); } catch(error) { expect(String(error)).not.toContain("sensitive-value"); }
        }
    });

    it("preserves integers, dates, multiline arrays and settings on other servers", () => {
        const prefix = 'count = 9223372036854775807\ndate = 2026-10-19\nratio = 1.0\n\n[mcp_servers.docs]\ncommand = "docs"\nargs = [\n  "# []",\n  "quoted",\n]\n\n';
        const before = prefix + '[mcp_servers.connection]\ncommand = "old"\n';
        expect(writeMcpServerToml(before, "connection", ENTRY).startsWith(prefix)).toBe(true);
    });

    it("preserves own __proto__ keys without polluting object prototypes", () => {
        const before = '[mcp_servers.__proto__]\ncommand = "npx"\nargs = []\n[mcp_servers.__proto__.env]\n__proto__ = "literal-value"\n';
        const entry = parseMcpServersToml(before).__proto__;
        expect(Object.hasOwn(entry.env, "__proto__")).toBe(true);
        expect(entry.env.__proto__).toBe("literal-value");
        expect(parseMcpServersToml(renderMcpServerTable("__proto__", entry)).__proto__).toEqual(entry);
    });
});

describe.each(["json", "toml"])("%s config write failures", (format) => {
    let filePath: string;
    let target: ConfigTarget;
    let original: string;
    beforeEach(async () => {
        if(format === "json") {
            filePath = path.join(directory, "mcp.json");
            target = createJsonFileTarget({ id: "cursor", label: "Cursor", filePath });
            original = JSON.stringify({ theme: "dark", mcpServers: { connection: ENTRY } });
        }
        else {
            vi.spyOn(os, "homedir").mockReturnValue(directory);
            vi.resetModules();
            const { createCodexTarget } = await import("@/modules/manage/targets/codex");
            target = createCodexTarget();
            filePath = path.join(directory, ".codex", "config.toml");
            expect(target.location).toBe(filePath);
            original = renderMcpServerTable("connection", ENTRY);
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, original);
    });

    it("keeps the original after a partial disk write and removes the temporary file", () => {
        const write = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file) => {
            write(file, "PARTIAL");
            throw new Error("ENOSPC");
        });
        expect(() => target.writeEntry("copy", ENTRY)).toThrow("ENOSPC");
        expect(fs.readFileSync(filePath, "utf8")).toBe(original);
        expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
    });

    it("keeps the original when committing the replacement fails", () => {
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("EPERM"); });
        expect(() => target.writeEntry("copy", ENTRY)).toThrow("EPERM");
        expect(fs.readFileSync(filePath, "utf8")).toBe(original);
        expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
    });

    it("does not overwrite a concurrent change observed before commit", () => {
        const write = fs.writeFileSync.bind(fs);
        const concurrent = original + "\n";
        vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { write(filePath, concurrent); });
        expect(() => target.writeEntry("copy", ENTRY)).toThrow(/changed while saving/);
        expect(fs.readFileSync(filePath, "utf8")).toBe(concurrent);
        expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
    });

    it("successfully commits a complete config and preserves other entries", () => {
        target.writeEntry("copy", { ...ENTRY, env: { KEY: "copied" } });
        expect(target.readEntries().connection).toEqual(ENTRY);
        expect(target.readEntries().copy.env).toEqual({ KEY: "copied" });
        expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
    });
});
