import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigTarget, McpServerEntry } from "@/_types";
import { runTargetConfigCommand as runConfigCommand } from "@/modules/manage";
import { createJsonFileTarget } from "@/modules/manage/targets/json-file";

const ENTRY: McpServerEntry = {
    command: "custom-npx",
    args: ["--yes", "@akms/mcp-ssh", "--custom-argument"],
    env: { SSH_HOST: "example.invalid", SSH_USER: "deploy", SSH_PASSWORD: "sensitive-value", SSH_PROXY_COMMAND: "ssh -W %h:%p gateway", CUSTOM: "sensitive-value" },
};
const OTHER = { command: "other-mcp", args: [], env: { KEEP: "yes" } };
let directory: string;
let source: ConfigTarget;
let destination: ConfigTarget;
let sourcePath: string;
let destinationPath: string;
let original: string;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ssh-copy-"));
    sourcePath = path.join(directory, "source.json");
    destinationPath = path.join(directory, "destination.json");
    original = JSON.stringify({ theme: "dark", mcpServers: { connection: ENTRY, unrelated: OTHER } }, null, 2);
    fs.writeFileSync(sourcePath, original);
    source = createJsonFileTarget({ id: "claude-code", label: "Claude Code", filePath: sourcePath });
    destination = createJsonFileTarget({ id: "cursor", label: "Cursor", filePath: destinationPath });
});

afterEach(() => {
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
    fs.rmSync(directory, { recursive: true, force: true });
});

async function run(lines: string[], targets = [source, destination]): Promise<string> {
    const input = new PassThrough();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk: Buffer) => { screen += chunk.toString(); });
    input.end(lines.map((line) => `${line}\n`).join(""));
    expect(await runConfigCommand({ input, output, targets, targetId: source.id })).toBe(0);
    return screen;
}

function seedDestination(entry: unknown): string {
    const text = JSON.stringify({ theme: "light", mcpServers: { connection: entry, unrelated: OTHER } }, null, 2);
    fs.writeFileSync(destinationPath, text);
    return text;
}

describe("copying a saved entry to another client", () => {
    it("creates the destination config with the exact saved command, args and all env values", async () => {
        const screen = await run(["connection", "o", "cursor", "q"]);
        expect(destination.readEntries().connection).toEqual(ENTRY);
        expect(screen).toContain("Copy to another client");
        expect(screen).toContain("Copied connection to Cursor");
        expect(screen).not.toContain("sensitive-value");
        const picker = screen.split("Copy connection to which client?")[1].split("Choice")[0];
        expect(picker).toContain("Cursor");
        expect(picker).not.toContain("Claude Code");
        expect(screen.trimEnd()).toMatch(/Choice \(1\):$/);
    });

    it.each(["", "n"])("keeps a same-name destination when overwrite is declined (%j)", async (answer) => {
        const before = seedDestination(OTHER);
        const screen = await run(["connection", "o", "cursor", answer, "q"]);
        expect(screen).toContain("Overwrite it?");
        expect(screen).toContain("Not copied");
        expect(fs.readFileSync(destinationPath, "utf8")).toBe(before);
    });

    it.each([
        ["another stdio package", OTHER],
        ["HTTP transport", { type: "http", url: "https://example.invalid/mcp" }],
        ["unrecognized entry", null],
    ])("asks before replacing %s under the same name", async (_label, previous) => {
        seedDestination(previous);
        const screen = await run(["connection", "o", "cursor", "y", "q"]);
        expect(screen).toContain("Overwrite it?");
        const document = JSON.parse(fs.readFileSync(destinationPath, "utf8"));
        expect(document).toEqual({ theme: "light", mcpServers: { connection: ENTRY, unrelated: OTHER } });
    });

    it("does not expose a copy action when no other client is available", async () => {
        const screen = await run(["connection", "b", "q"], [source]);
        expect(screen).not.toContain("Copy to another client");
    });

    it.each([{ answers: ["\u001b"] }, { answers: ["b"] }, { answers: [] }])("writes nothing when leaving the destination picker: %j", async ({ answers }) => {
        await run(["connection", "o", ...answers, ...(answers.length ? ["q"] : [])]);
        expect(fs.existsSync(destinationPath)).toBe(false);
    });

    it("Esc at overwrite returns to the destination picker and allows choosing a different client", async () => {
        const before = seedDestination(OTHER);
        const desktop = createJsonFileTarget({ id: "claude-desktop", label: "Claude Desktop", filePath: path.join(directory, "desktop.json") });
        const screen = await run(["connection", "o", "cursor", "\u001b", "claude-desktop", "q"], [source, destination, desktop]);
        expect(fs.readFileSync(destinationPath, "utf8")).toBe(before);
        expect(desktop.readEntries().connection).toEqual(ENTRY);
        expect(screen).toContain("Copied connection to Claude Desktop");
    });

    it("EOF at overwrite preserves both configurations", async () => {
        const before = seedDestination(OTHER);
        await run(["connection", "o", "cursor"]);
        expect(fs.readFileSync(destinationPath, "utf8")).toBe(before);
    });

    it.each(['{ "mcpServers":', '{"mcpServers": []}', '{"mcpServers": null}'])("refuses unreadable destination data: %s", async (before) => {
        fs.writeFileSync(destinationPath, before);
        const screen = await run(["connection", "o", "cursor", "q"]);
        expect(screen).toContain("Failed:");
        expect(screen).not.toContain("Copied connection");
        expect(fs.readFileSync(destinationPath, "utf8")).toBe(before);
    });

    it("reports unavailable writers without claiming success or switching clients", async () => {
        const write = vi.fn(() => ({ status: "unavailable" as const, detail: "client CLI not found" }));
        const screen = await run(["connection", "o", "cursor", "q"], [source, { ...destination, writeEntry: write }]);
        expect(write).toHaveBeenCalledTimes(1);
        expect(screen).toContain("Not copied: client CLI not found");
        expect(screen).not.toContain("Copied connection");
        expect(fs.existsSync(destinationPath)).toBe(false);
    });

    it("reports write failures and keeps the source selectable", async () => {
        const screen = await run(["connection", "o", "cursor", "connection", "b", "q"], [
            source,
            { ...destination, writeEntry() { throw new Error("permission denied"); } },
        ]);
        expect(screen).toContain("Failed: permission denied");
        expect(screen).not.toContain("Copied connection");
    });
});
