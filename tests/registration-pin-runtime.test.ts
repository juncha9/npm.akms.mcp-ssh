import fs from "node:fs";
import { removeTempDirectory } from "./support/remove-temp-directory";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigCommand } from "../src/modules/manage";
import { Registry } from "../src/modules/registration/registry";
import { createJsonFileTarget } from "../src/modules/manage/targets/json-file";
import type { GlobalRuntime } from "../src/modules/registration/runtime";

vi.mock("../src/modules/manage/connection-check", async (original) => ({
    ...await original<typeof import("../src/modules/manage/connection-check")>(),
    runConnectionCheck: vi.fn(async () => ({ connected: true, hostKeyFingerprint: "SHA256:test-fingerprint" })),
}));
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-pin-runtime-")); vi.stubEnv("AKMS_MCP_HOME", directory); fs.writeFileSync(path.join(directory, "registry.json"), JSON.stringify({ version: 1, clients: [], connections: {} })); });
afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTempDirectory(directory, "akms-pin-runtime-");
}, 15_000);

describe("runtime preparation before pinning", () => {
    it.each([[true, false], [false, false], [false, true]])("handles pinning with installation success=%s and custom launch=%s", async (success, custom) => {
        const target = createJsonFileTarget({ id: "cursor", label: "Cursor", filePath: path.join(directory, "cursor.json") });
        const file = path.join(directory, "registry.json");
        let runtime: GlobalRuntime | null = null;
        const install = vi.fn(async () => {
            if(!success) throw new Error("isolated install failure");
            runtime = { command: process.execPath, args: [path.join(directory, "runtime", "node_modules", "@akms", "mcp-ssh", "lib", "cli.js")], version: "99.0.0", linked: false };
        });
        const runtimeOptions = { find: () => runtime, install };
        const registry = new Registry([target], file, runtimeOptions);
        registry.register(["cursor"]);
        const entry = { command: "npx", args: ["-y", "@akms/mcp-ssh", ...(custom ? ["--custom"] : [])], env: {"SSH_HOST":"ssh.local","SSH_USER":"test"} };
        registry.write("ssh", "legacy", entry);
        const input = new PassThrough(), output = new PassThrough();
        let text = ""; output.on("data", chunk => { text += chunk; });
        input.end(["legacy", "c", "y", "q"].join("\n") + "\n");
        await runConfigCommand({ input, output, targets: [target], registryPath: file, runtimeOptions });
        expect(install).toHaveBeenCalledTimes(custom ? 0 : 1);
        if(success || custom) {
            expect(target.readEntries().legacy.env.SSH_HOST_KEY).toBe("SHA256:test-fingerprint");
            expect(target.readEntries().legacy.command).toBe(custom ? "npx" : process.execPath);
            if(custom) expect(target.readEntries().legacy.args).toEqual(entry.args);
        } else {
            expect(text).toContain("isolated install failure");
            expect(target.readEntries().legacy).toEqual(entry);
        }
    });
});
