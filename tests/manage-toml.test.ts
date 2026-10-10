import { describe, expect, it } from "vitest";

import type { McpServerEntry } from "@/_types";
import { parseMcpServersToml, renderMcpServerTable, writeMcpServerToml } from "@/modules/manage/targets/toml-subset";

/** A Codex config as a person keeps it: settings, comments, another server, a hand-tuned key. */
const CODEX_CONFIG = [
    "model = \"gpt-5-codex\"",
    "approval_policy = \"on-request\"  # ask before running",
    "",
    "[mcp_servers.docs]",
    "command = \"docs-mcp\"",
    "args = [",
    "    \"--port\",",
    "    \"9000\",",
    "]",
    "env = { DOCS_TOKEN = \"abc\" }",
    "",
    "[mcp_servers.ssh-prod]",
    "command = \"npx\"",
    "args = [\"-y\", \"@akms/mcp-ssh\"]",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.ssh-prod.env]",
    "SSH_HOST = \"10.0.0.5\"",
    "SSH_USER = \"deploy\"",
    "",
    "[mcp_servers.ssh-prod.tools.ssh_exec]",
    "approval_mode = \"always\"",
    "",
    "[profiles.fast]",
    "model = \"gpt-5-mini\"",
    "",
].join("\n");

const NEW_ENTRY: McpServerEntry = {
    command: "npx",
    args: ["-y", "@akms/mcp-ssh"],
    env: {
        SSH_HOST: "10.0.0.6",
        SSH_USER: "ops",
        SSH_KEY: "C:\\Users\\me\\.ssh\\id_ed25519",
        SSH_DESCRIPTION: "the \"new\" box",
    },
};

describe("parseMcpServersToml", () => {
    it("reads every server, with env from a sub-table or an inline table", () => {
        const entries = parseMcpServersToml(CODEX_CONFIG);

        expect(entries.docs).toEqual({ command: "docs-mcp", args: ["--port", "9000"], env: { DOCS_TOKEN: "abc" } });
        expect(entries["ssh-prod"]).toEqual({
            command: "npx",
            args: ["-y", "@akms/mcp-ssh"],
            env: { SSH_HOST: "10.0.0.5", SSH_USER: "deploy" },
        });
        expect(Object.keys(entries)).toEqual(["docs", "ssh-prod"]);
    });

    it("returns nothing for an empty file", () => {
        expect(parseMcpServersToml("")).toEqual({});
    });
});

describe("writeMcpServerToml", () => {
    it("round-trips Windows paths and quotes through rendering and parsing", () => {
        const text = renderMcpServerTable("ssh-new", NEW_ENTRY);

        expect(parseMcpServersToml(text)["ssh-new"]).toEqual(NEW_ENTRY);
    });

    it("appends a new server after a blank line, leaving the file before it byte for byte", () => {
        const updated = writeMcpServerToml(CODEX_CONFIG, "ssh-new", NEW_ENTRY);

        expect(updated.startsWith(CODEX_CONFIG.replace(/\n+$/, ""))).toBe(true);
        expect(updated).toContain("gpt-5-mini\"\n\n[mcp_servers.ssh-new]\n");
        expect(parseMcpServersToml(updated)["ssh-new"]).toEqual(NEW_ENTRY);
    });

    it("creates a file from nothing", () => {
        const updated = writeMcpServerToml("", "ssh-new", NEW_ENTRY);

        expect(updated).toBe(renderMcpServerTable("ssh-new", NEW_ENTRY));
    });

    it("replaces command, args and env but keeps the keys and sub-tables added by hand", () => {
        const updated = writeMcpServerToml(CODEX_CONFIG, "ssh-prod", NEW_ENTRY);

        expect(parseMcpServersToml(updated)["ssh-prod"]).toEqual(NEW_ENTRY);
        expect(updated).toContain("startup_timeout_sec = 30");
        expect(updated).toContain("[mcp_servers.ssh-prod.tools.ssh_exec]\napproval_mode = \"always\"");
        expect(updated).not.toContain("10.0.0.5");
    });

    it("leaves every other server and setting untouched on replace", () => {
        const updated = writeMcpServerToml(CODEX_CONFIG, "ssh-prod", NEW_ENTRY);
        const entries = parseMcpServersToml(updated);

        expect(entries.docs).toEqual(parseMcpServersToml(CODEX_CONFIG).docs);
        expect(updated.startsWith(CODEX_CONFIG.slice(0, CODEX_CONFIG.indexOf("[mcp_servers.ssh-prod]")))).toBe(true);
        expect(updated.endsWith("[profiles.fast]\nmodel = \"gpt-5-mini\"\n")).toBe(true);
    });

    it("is stable: writing the same entry twice gives the same text", () => {
        const once = writeMcpServerToml(CODEX_CONFIG, "ssh-prod", NEW_ENTRY);
        const twice = writeMcpServerToml(once, "ssh-prod", NEW_ENTRY);

        expect(twice).toBe(once);
    });

    it("removes the server with all of its sub-tables and nothing else", () => {
        const updated = writeMcpServerToml(CODEX_CONFIG, "ssh-prod", null);

        expect(parseMcpServersToml(updated)["ssh-prod"]).toBeUndefined();
        expect(updated).not.toContain("ssh-prod");
        expect(updated).toContain("[mcp_servers.docs]");
        expect(updated).toContain("[profiles.fast]");
        expect(updated).not.toContain("\n\n\n");
    });

    it("keeps CRLF line endings", () => {
        const crlf = CODEX_CONFIG.replace(/\n/g, "\r\n");
        const updated = writeMcpServerToml(crlf, "ssh-prod", NEW_ENTRY);

        expect(updated.replace(/\r\n/g, "")).not.toContain("\n");
        expect(parseMcpServersToml(updated)["ssh-prod"]).toEqual(NEW_ENTRY);
    });

    it("does not mistake a line of a multi-line array for a table header", () => {
        const text = [
            "[mcp_servers.ssh-prod]",
            "command = \"npx\"",
            "args = [",
            "[\"nested\"],",
            "]",
            "",
        ].join("\n");

        const updated = writeMcpServerToml(text, "ssh-prod", NEW_ENTRY);

        expect(parseMcpServersToml(updated)["ssh-prod"]).toEqual(NEW_ENTRY);
        expect(updated).not.toContain("nested");
    });
});
