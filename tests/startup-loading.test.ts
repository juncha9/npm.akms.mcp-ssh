import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("cold process memory", () => {
    it("keeps the SSH runtime unloaded until connecting and honours disconnect during its first load", () => {
        const entry = new URL("../src/index.ts", import.meta.url).href;
        const script = `
            import assert from "node:assert/strict";
            import { createRequire } from "node:module";
            import { sep } from "node:path";
            const require = createRequire(process.cwd() + "/package.json");
            const loaded = () => Object.keys(require.cache).some(file => file.includes(sep + "ssh2" + sep));
            const api = await import(${JSON.stringify(entry)});
            const instance = api.createSshMcpServer();
            try {
                assert(instance.profile);
                assert.equal(loaded(), false);
                const connection = new api.SshConnection(instance.profile);
                const first = connection.connect();
                const second = connection.connect();
                connection.disconnect();
                const attempts = await Promise.allSettled([first, second]);
                assert(attempts.every(result => result.status === "rejected" && /closed/.test(result.reason.message)));
                assert.equal(loaded(), true);
                console.log("passed");
            } finally {
                instance.shutdown();
                await instance.server.close();
            }
        `;
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SSH_|NODE_OPTIONS$)/i.test(key)));
        const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...env, SSH_HOST: "127.0.0.1", SSH_PORT: "1", SSH_USER: "memory", SSH_PASSWORD: "memory", SSH_MCP_LOG_LEVEL: "silent" },
            encoding: "utf8", timeout: 20000, windowsHide: true,
        });
        expect(result.trim()).toBe("passed");
    }, 25000);
});
