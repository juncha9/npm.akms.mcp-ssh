import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// When the MCP client dies, every pipe the server holds dies with it. The server sees stdin end
// and starts shutting down — and its first log line goes to a stderr nobody reads any more.
// Measured on 2026-10-13 in @akms/mcp-db with Claude Code's `cmd /c` launch on Windows: that write
// failed with EPIPE, the failure was logged, which failed again, and the loop starved the event
// loop. The server stayed behind at 100% CPU and never reached process.exit. Started directly (no
// cmd hop) the exit won the race, so the client below launches the server the way Claude Code does.

const DYING_CLIENT_PATH = fileURLToPath(new URL("_fixtures/dying-client.ts", import.meta.url));

function isAlive(pid: number): boolean {
    // Signal 0 to pid 0 would probe this process's own group and always answer true
    if (pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}

describe.runIf(process.platform === "win32")("shutdown when the client dies", () => {
    let serverPid: number | null = null;

    afterEach(() => {
        if (serverPid != null && isAlive(serverPid) == true) {
            execFileSync("taskkill", ["/PID", String(serverPid), "/F", "/T"], { stdio: "ignore" });
        }
    });

    it("exits on its own instead of looping on a stderr that has no reader", async () => {
        // A vitest worker has no real stderr to inherit; the client's own stderr says nothing of interest anyway
        const client = spawn(process.execPath, ["--import", "tsx", DYING_CLIENT_PATH], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let clientOutput = "";
        client.stdout.on("data", (chunk: Buffer) => {
            clientOutput += String(chunk);
        });
        await once(client, "exit");
        serverPid = Number(clientOutput.trim());
        expect(serverPid).toBeGreaterThan(0);

        // The client is dead. The server has to notice and leave within a few seconds.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && isAlive(serverPid) == true) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(isAlive(serverPid)).toBe(false);
    }, 20000);
});
