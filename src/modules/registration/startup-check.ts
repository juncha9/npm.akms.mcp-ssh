import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleField, writeWrapped } from "./comparison";
import type { Prompter } from "./prompter";
import type { McpServerEntry } from "./types";
import { launchKind, standardLaunch } from "./runtime";

export interface StartupResult {
    ok: boolean;
    server?: string;
    version?: string;
    tools?: number;
    toolNames?: string[];
    exitCode: number | null;
    detail?: string;
    stderr: string[];
}

function visibleRuntimePath(entry: McpServerEntry): string | undefined {
    const kind = launchKind(entry);
    return kind && standardLaunch({ ...entry, args: entry.args.slice(0, 1) }, kind)
        && (entry.args.length === 1 || entry.args.length === 2 && entry.args[1] === "--catalog") ? entry.args[0] : undefined;
}

/** Match the preview's allowlist: all other env values and launch arguments are private. */
export function redactStartupText(text: string, entry: McpServerEntry): string {
    const normalize = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    const direct = visibleRuntimePath(entry);
    const privateValues = [...Object.entries(entry.env).filter(([key]) => !visibleField.test(key)).map(([, value]) => value), ...entry.args.slice(direct ? 1 : 0)];
    const secrets = new Set<string>();
    for(const value of privateValues) {
        if(!value) continue;
        secrets.add(value);
        const values = [value];
        if(value.includes("=")) values.push(value.slice(value.indexOf("=") + 1));
        for(const candidate of values) {
            secrets.add(candidate);
            try {
                const url = new URL(candidate);
                if(url.password) { secrets.add(url.password); secrets.add(decodeURIComponent(url.password)); }
            } catch { /* Not a URL. */ }
        }
    }
    for(const value of [...secrets]) {
        if(!value) continue;
        secrets.add(JSON.stringify(value).slice(1, -1));
        secrets.add(encodeURIComponent(value));
    }
    for(const value of [...secrets]) secrets.add(normalize(value));
    let result = normalize(text);
    for(const value of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(value).join("(hidden)");
    return result;
}

/** A bounded stdio handshake only: no tools/call, shell interpolation or SDK dependency. */
export async function checkStartup(entry: McpServerEntry, timeoutMs = 10_000): Promise<StartupResult> {
    return new Promise((resolve) => {
        const inherited = process.platform === "win32"
            ? ["APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "PROGRAMFILES"]
            : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR"];
        const env = Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
        let stderr = "", stderrOmitted = false, output = "", bytes = 0, done = false, closing = false, detail: string | undefined;
        let server: string | undefined, version: string | undefined, tools = 0, expected = 1, pages = 0;
        const toolNames: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined, endTimer: ReturnType<typeof setTimeout> | undefined;
        let child: ReturnType<typeof spawn>;
        const result = (code: number | null, signal?: string | null) => {
            if(done) return;
            done = true;
            clearTimeout(timer); clearTimeout(killTimer); clearTimeout(endTimer);
            const clean = (value: string) => redactStartupText(value, entry);
            const ok = !detail && closing && code === 0;
            const runtime = visibleRuntimePath(entry);
            const failure = detail ?? (code !== 0 ? `Exited ${code ?? signal ?? "without an exit code"}.` : "Startup check did not finish.");
            resolve({ ok, server: server && clean(server).slice(0, 200), version: version && clean(version).slice(0, 100), tools, toolNames: toolNames.map(clean),
                exitCode: code, detail: ok ? undefined : clean(`${failure}${runtime ? ` Runtime: ${runtime}` : ""}`).slice(0, 2000),
                stderr: clean(stderr).trim().split(/\r?\n/).filter(Boolean).slice(-6).map(line => line.slice(0, 500)) });
        };
        const stop = (reason?: string) => {
            if(closing || done) return;
            closing = true; detail = reason;
            clearTimeout(timer);
            child.stdin?.end();
            killTimer = setTimeout(() => {
                if(process.platform === "win32" && child.pid) {
                    execFile(path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 4000 }, () => {});
                } else if(child.pid) {
                    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
                }
                endTimer = setTimeout(() => { child.kill("SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); result(null); }, 4500);
            }, 500);
        };
        try {
            child = spawn(entry.command, entry.args, { env: { ...env, ...entry.env }, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
        } catch(error) { detail = error instanceof Error ? error.message : "Unable to start process."; result(null); return; }
        timer = setTimeout(() => stop(`Timed out after ${timeoutMs} ms.`), timeoutMs);
        const send = (message: unknown) => child.stdin?.write(JSON.stringify(message) + "\n");
        child.on("error", (error: NodeJS.ErrnoException) => { detail = `Unable to start ${entry.command} (${error.code ?? "error"}).`; closing = true; result(null); });
        child.on("close", (code, signal) => { if(!closing) detail ??= "Process exited before initialize and tools/list completed."; result(code, signal); });
        child.stdin?.on("error", () => { if(!closing) stop("Server closed its input before the startup check completed."); });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            if(stderrOmitted) return;
            stderr += chunk;
            // Do not truncate inside an unredacted secret. Excessive diagnostics fail closed.
            if(stderr.length > 65_536) { stderrOmitted = true; stderr = "[stderr exceeded the diagnostic limit; output omitted]"; stop("Too much stderr output."); }
        });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            if(closing || done) return;
            bytes += Buffer.byteLength(chunk);
            if(bytes > 2 * 1024 * 1024) { stop("MCP response exceeded the startup check limit."); return; }
            output += chunk;
            let newline: number;
            while(!closing && (newline = output.indexOf("\n")) >= 0) {
                const line = output.slice(0, newline); output = output.slice(newline + 1);
                try {
                    const message = JSON.parse(line);
                    if(message?.jsonrpc !== "2.0") throw new Error();
                    if(message.method) {
                        if(message.id !== undefined) send(message.method === "ping" ? { jsonrpc: "2.0", id: message.id, result: {} } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported by startup check" } });
                        continue;
                    }
                    if(message.id !== expected) continue;
                    if(message.error) { stop(`MCP request failed: ${typeof message.error.message === "string" ? message.error.message : "server error"}`); break; }
                    if(expected === 1) {
                        if(typeof message.result?.protocolVersion !== "string"
                            || typeof message.result?.serverInfo?.name !== "string" || typeof message.result?.serverInfo?.version !== "string") throw new Error();
                        server = message.result.serverInfo.name; version = message.result.serverInfo.version;
                        send({ jsonrpc: "2.0", method: "notifications/initialized" });
                        send({ jsonrpc: "2.0", id: ++expected, method: "tools/list", params: {} });
                    } else {
                        if(!Array.isArray(message.result?.tools) || !message.result.tools.every((tool: { name?: unknown }) => typeof tool?.name === "string")) throw new Error();
                        tools += message.result.tools.length;
                        toolNames.push(...message.result.tools.map((tool: { name: string }) => tool.name));
                        if(message.result.nextCursor !== undefined) {
                            if(typeof message.result.nextCursor !== "string" || ++pages > 100) throw new Error();
                            send({ jsonrpc: "2.0", id: ++expected, method: "tools/list", params: { cursor: message.result.nextCursor } });
                        } else stop();
                    }
                } catch { stop("Invalid MCP response on stdout."); }
            }
        });
        child.once("spawn", () => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "akms-startup-check", version: "1.0.0" } } }));
    });
}

export async function checkConnections(prompter: Prompter, entries: { name: string; entry: McpServerEntry; prefixes?: string[]; maskEntries?: McpServerEntry[] }[], check = checkStartup): Promise<void> {
    if(!entries.length) return;
    prompter.write("\nStartup check (initialize and tools/list only)\n");
    const checked = new Map<string, StartupResult>();
    let failed = false;
    for(const { name, entry, prefixes, maskEntries } of entries) {
        const key = JSON.stringify([entry.command, entry.args, Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b))]);
        let result = checked.get(key);
        if(!result) {
            try { result = await check(entry); }
            catch { result = { ok: false, exitCode: null, detail: "Unable to complete the startup check.", stderr: [] }; }
            checked.set(key, result);
        }
        const listedNames = result.toolNames ?? [];
        // A connection name can itself contain "__". Assign tools to the longest
        // known prefix so prod__archive cannot hide a missing prod connection.
        const longestFirst = [...prefixes ?? []].sort((a, b) => b.length - a.length);
        const covered = new Set(listedNames.map(tool => longestFirst.find(prefix => tool.startsWith(prefix))));
        const missing = prefixes?.filter(prefix => !covered.has(prefix)) ?? [];
        if(result.ok && missing.length) result = { ...result, ok: false, detail: `Missing connection tools: ${missing.map(prefix => prefix.slice(0, -2)).join(", ")}. Review catalog status before reconnecting.` };
        const safe = (value: string) => [entry, ...maskEntries ?? []].reduce((text, source) => redactStartupText(text, source), value);
        writeWrapped(prompter, safe(result.ok ? `OK ${name}: ${result.server}@${result.version}, ${result.tools} tools` : `FAILED ${name}: exit ${result.exitCode ?? "unavailable"}. ${result.detail ?? "Server failed to start."}`));
        if(!result.ok) {
            failed = true;
            for(const line of result.stderr) writeWrapped(prompter, safe(line), "  ");
        }
    }
    if(failed) prompter.write("Settings remain saved. Fix failed startup checks before restarting or reconnecting your AI clients.\n");
}
