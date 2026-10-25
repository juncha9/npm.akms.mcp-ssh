import fs from "node:fs";
import { removeTempDirectory } from "./support/remove-temp-directory";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, defaultRegistryPath } from "../src/modules/registration/registry";
import { registrationMenu, importMenu } from "../src/modules/registration/menu";
import { Prompter } from "../src/modules/registration/prompter";
import type { ConfigTarget, McpKind, McpServerEntry } from "../src/modules/registration/types";

let directory: string;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-catalog-security-"));
    vi.stubEnv("AKMS_MCP_HOME", path.join(directory, "catalog"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await removeTempDirectory(directory, "akms-catalog-security-");
}, 15_000);

function fixture({ legacy = true } = {}) {
    if(legacy) {
        fs.mkdirSync(path.dirname(defaultRegistryPath()), { recursive: true, mode: 0o700 });
        fs.writeFileSync(defaultRegistryPath(), JSON.stringify({ version: 1, clients: [], connections: {} }), { mode: 0o600 });
    }
    const file = path.join(directory, "client.json");
    const read = (): Record<string, McpServerEntry> => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const target: ConfigTarget = {
        id: "cursor", label: "Cursor", detected: true, location: file, readEntries: read,
        writeEntry: (name, entry) => { fs.writeFileSync(file, JSON.stringify({ ...read(), [name]: entry })); return { status: "written", detail: file }; },
        removeEntry: (name) => { const entries = read(); delete entries[name]; fs.writeFileSync(file, JSON.stringify(entries)); return { status: "written", detail: file }; },
    };
    return { registry: new Registry([target], undefined, { find: kind => ({ command: process.execPath, args: [path.join(directory, "runtime/node_modules/@akms", `mcp-${kind}`, "lib/cli.js")], version: "1.0.0", linked: false }) }), target };
}
async function screen(lines: string[], action: (prompter: Prompter) => Promise<unknown>) {
    const input = new PassThrough(), output = new PassThrough();
    let text = ""; output.on("data", value => { text += value; });
    input.end(lines.join("\n") + "\n");
    const prompter = new Prompter(input, output);
    try { await action(prompter); } finally { prompter.close(); }
    return text;
}
const entry = (kind: McpKind, env: Record<string, string>): McpServerEntry => ({ command: "npx", args: ["-y", `@akms/mcp-${kind}`], env });

describe("catalog security documentation evidence", () => {
    it("stores complete credential values in plaintext, matching the client, while SSH keys remain paths", () => {
        const { registry, target } = fixture();
        const key = path.join(directory, "fixture-private-key");
        fs.writeFileSync(key, "PRIVATE KEY CONTENT MUST NOT BE COPIED");
        const values: Record<McpKind, McpServerEntry> = {
            db: entry("db", { DB_PASSWORD: "fixture-db-password", DB_URL: "postgres://user:fixture-url-password@localhost/db", DB_SSH_PASSWORD: "fixture-tunnel-password", DB_SSH_PASSPHRASE: "fixture-key-passphrase", DB_SSH_KEY: key }),
            ssh: entry("ssh", { SSH_PASSWORD: "fixture-ssh-password", SSH_PASSPHRASE: "fixture-ssh-passphrase", SSH_JUMP_PASSWORD: "fixture-jump-password", SSH_JUMP_PASSPHRASE: "fixture-jump-passphrase", SSH_KEY: key, SSH_JUMP_KEY: key }),
            s3: entry("s3", { S3_ACCESS_KEY_ID: "fixture-access-key", S3_SECRET_ACCESS_KEY: "fixture-secret-key", S3_SESSION_TOKEN: "fixture-session-token" }),
            wsl: entry("wsl", { WSL_DISTRO: "Ubuntu", CUSTOM_VALUE: "preserved" }),
        };
        registry.register(["cursor"]);
        for(const [kind, value] of Object.entries(values)) registry.write(kind as McpKind, kind, value);
        const text = fs.readFileSync(registry.file, "utf8");
        const parsed = JSON.parse(text);
        for(const [kind, value] of Object.entries(values)) {
            expect(parsed.connections[kind].entry).toEqual(value);
            expect(target.readEntries()[kind]).toEqual(value);
            for(const secret of Object.values(value.env).filter(value => value.startsWith("fixture-"))) expect(text).toContain(secret);
        }
        expect(text).not.toContain("PRIVATE KEY CONTENT MUST NOT BE COPIED");
    });

    it("uses the configured catalog directory and requests private creation modes", () => {
        const { registry } = fixture({ legacy: false });
        const mkdir = vi.spyOn(fs, "mkdirSync"), open = vi.spyOn(fs, "openSync");
        registry.register(["cursor"]);
        expect(defaultRegistryPath()).toBe(path.join(directory, "catalog", "registry.json"));
        expect(mkdir).toHaveBeenCalledWith(path.dirname(registry.file), { recursive: true, mode: 0o700 });
        expect(open.mock.calls.some(([file, flags, mode]) => String(file).endsWith(".tmp") && flags === "wx" && mode === 0o600)).toBe(true);
        if(process.platform !== "win32") {
            expect(fs.statSync(registry.file).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.dirname(registry.file)).mode & 0o777).toBe(0o700);
        }
        vi.stubEnv("AKMS_MCP_HOME", "");
        expect(defaultRegistryPath()).toBe(path.join(os.homedir(), ".akms", "mcp", "registry.json"));
    });

    it("shows the privacy notice once across repeated Apply reviews in plain piped input", async () => {
        const { registry } = fixture();
        const text = await screen(["cursor", "a", "n", "a", "y"], prompter => registrationMenu(prompter, registry));
        expect(text.match(/Connection settings, including passwords, are stored in/g)).toHaveLength(1);
        expect(text.replace(/\r?\n/g, "")).toContain(registry.file);
        expect(text.match(/Keep this file private: do not share, sync or commit it\./g)).toHaveLength(1);
        expect(text).not.toContain("\u001b");
        expect(registry.read().clients).toEqual(["cursor"]);
    });

    it("does not repeat the privacy notice while only selecting services", async () => {
        const { registry } = fixture({ legacy: false });
        const text = await screen(["cursor", "cursor", "cursor", "back"], prompter => registrationMenu(prompter, registry));
        expect(text).not.toContain("Connection settings, including passwords");
        expect(fs.existsSync(registry.file)).toBe(false);
    });

    it("defaults to No when removing a registered service and preserves its entries on Enter", async () => {
        const { registry, target } = fixture();
        registry.register(["cursor"]);
        const original = entry("db", { DB_HOST: "fixture.local" });
        registry.write("db", "fixture", original);
        const text = await screen(["cursor", "a", "", "back"], prompter => registrationMenu(prompter, registry));
        expect(text).toContain("Apply this registration? (y/N)");
        expect(registry.read().clients).toEqual(["cursor"]);
        expect(target.readEntries().fixture).toEqual(original);
    });

    it("keeps Yes as the default when registration does not remove a service", async () => {
        const { registry } = fixture();
        const text = await screen(["cursor", "a", ""], prompter => registrationMenu(prompter, registry));
        expect(text).toContain("Apply this registration? (Y/n)");
        expect(registry.read().clients).toEqual(["cursor"]);
    });

    it("keeps individual client entries after catalog deletion and imports them into a new session catalog", async () => {
        const { registry, target } = fixture();
        const original = entry("db", { DB_HOST: "fixture.local", DB_PASSWORD: "fixture-password" });
        registry.register(["cursor"]); registry.write("db", "fixture", original);
        const clientBefore = fs.readFileSync(target.location, "utf8");
        fs.unlinkSync(registry.file);
        expect(target.readEntries().fixture).toEqual(original);
        const restored = new Registry([target], undefined, registry.runtimeOptions);
        expect(restored.read()).toEqual({ version: 2, defaultMode: "catalog", clients: [], connections: {}, sessions: {} });
        restored.register(["cursor"]);
        const text = await screen(["2", "y", "back"], prompter => importMenu(prompter, restored));
        expect(text).toContain("Import complete");
        expect(restored.read().connections.fixture.entry).toEqual(original);
        expect(Object.keys(target.readEntries())).toEqual(["akms_db"]);
        expect(target.readEntries().akms_db.env).toEqual({ AKMS_MCP_HOME: path.dirname(restored.file) });
        expect(fs.readFileSync(target.location, "utf8")).not.toContain("fixture-password");
        expect(text).not.toContain("fixture-password");
    });
});
