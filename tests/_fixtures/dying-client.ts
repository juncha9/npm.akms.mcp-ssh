import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// An MCP client that dies without stopping its server, the way a Claude Code session ends on Windows:
// the server is started through `cmd /c` (Claude Code wraps npx servers in `cmd /c npx …` there),
// the handshake completes, and then this process exits abruptly, leaving the server on dead pipes.
// Prints the server's pid on stdout, read from the server's own "mcp server ready" log line.

const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const server = spawn("cmd", ["/c", process.execPath, "--import", "tsx", CLI_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
        ...process.env,
        // No host is configured: the server starts with its tools registered and no profile
        // This client reads the pid from the server's log, so the level must be at least info
        SSH_MCP_LOG_LEVEL: "info",
    },
});

let stderrText = "";
let serverPid: number | null = null;
let handshakeDone = false;

// Die once the pid is known and the handshake is done — after the pid has left this process:
// on Windows a write to a stdout pipe is asynchronous, and process.exit would drop it
function dieWhenReady(): void {
    if (serverPid == null || handshakeDone == false) {
        return;
    }
    process.stdout.write(`${serverPid}\n`, () => {
        process.exit(0);
    });
}

server.stderr.on("data", (chunk: Buffer) => {
    stderrText += String(chunk);
    const match = /"pid":(\d+)/.exec(stderrText);
    if (match != null && serverPid == null) {
        serverPid = Number(match[1]);
        dieWhenReady();
    }
});
server.stdout.on("data", (chunk: Buffer) => {
    if (String(chunk).includes("\"serverInfo\"") == false) {
        return;
    }
    handshakeDone = true;
    dieWhenReady();
});

const initializeRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dying-client", version: "0" } },
});
server.stdin.write(`${initializeRequest}\n`);
