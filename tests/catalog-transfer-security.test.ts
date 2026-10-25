import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFileTools } from "../src/modules/tools/file-tools";
import type { ToolContext } from "../src/modules/tools/tool-context";
import { inspectLocalPath, inspectRemotePath } from "../src/modules/guard";
import { createPolicy, createProfile } from "./_helpers";

const transfer = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("../src/modules/tools/tool-context", async (original) => ({ ...await original<typeof import("../src/modules/tools/tool-context")>(), withHostConnection: transfer }));
let directory: string;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-transfer-security-"));
    vi.stubEnv("SSH_MCP_LOG_LEVEL", "silent");
    transfer.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

function tools() {
    const handlers = new Map<string, (args: unknown) => Promise<{ isError?: boolean }>>();
    registerFileTools({ registerTool: (name: string, _options: unknown, handler: (args: unknown) => Promise<{ isError?: boolean }>) => handlers.set(name, handler) } as unknown as McpServer,
        { profile: createProfile(), sessions: {} } as ToolContext);
    return handlers;
}

describe("catalog transfer security evidence", () => {
    it.each(["ssh_upload", "ssh_download"])("blocks the local default catalog through %s", async (name) => {
        const localPath = path.join(directory, ".akms", "mcp", "registry.json");
        fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, "fixture");
        const result = await tools().get(name)!({ localPath, remotePath: "/tmp/fixture" });
        expect(result.isError).toBe(true);
        expect(transfer).not.toHaveBeenCalled();
        for(const access of ["read", "write"] as const) expect(inspectLocalPath(path.join(path.dirname(localPath), "other.json"), access).allowed).toBe(false);
    });

    it.each(["ssh_upload", "ssh_download"])("protects the configured custom registry, but not its entire directory, through %s", async (name) => {
        const home = path.join(directory, "custom-catalog");
        vi.stubEnv("AKMS_MCP_HOME", home);
        fs.mkdirSync(home); fs.writeFileSync(path.join(home, "registry.json"), "fixture");
        const result = await tools().get(name)!({ localPath: path.join(home, "registry.json"), remotePath: "/tmp/fixture" });
        expect(result.isError).toBe(true);
        expect(transfer).not.toHaveBeenCalled();
        for(const access of ["read", "write"] as const) expect(inspectLocalPath(path.join(home, "backup.json"), access).allowed).toBe(true);
        for(const access of ["read", "write"] as const) expect(inspectLocalPath(path.join(home, "registry.previous.json"), access).allowed).toBe(false);
        vi.stubEnv("AKMS_MCP_HOME", "");
        expect(inspectLocalPath(path.join(home, "registry.json"), "read").allowed).toBe(true);
    });

    it.each(["read", "write"] as const)("remote catalog paths have no special exclusion for %s access", (access) => {
        const remote = "/home/user/.akms/mcp/registry.json";
        expect(inspectRemotePath(remote, createPolicy(), access).allowed).toBe(true);
        expect(inspectRemotePath(remote, createPolicy({ allowedPaths: ["/srv/app"] }), access).allowed).toBe(false);
    });
});
