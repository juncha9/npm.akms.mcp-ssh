import type { Registry } from "./registry";
import { packageName, runtimeIsOlder } from "./runtime";
import { writeWrapped } from "./comparison";
import { redactStartupText } from "./startup-check";
import { Prompter, PromptBackError, PromptClosedError } from "./prompter";
import { KINDS, type McpKind } from "./types";

/** Query only on entry or explicit Refresh. Main menus remain offline and immediate. */
export async function updatesMenu(prompter: Prompter, registry: Registry): Promise<void> {
    const kinds = KINDS.filter(kind => kind !== "wsl" || process.platform === "win32");
    const latest = new Map<McpKind, string | null>();
    const refresh = async () => {
        prompter.clearScreen(); prompter.write("Updates / checking published runtime versions...\n");
        await Promise.all(kinds.map(async kind => {
            try { latest.set(kind, await registry.latestRuntime(kind)); }
            catch { latest.set(kind, null); }
        }));
    };
    await refresh();
    for(;;) {
        try {
            prompter.clearScreen();
            prompter.write("Updates / AKMS runtimes\n\n");
            const rows = kinds.map(kind => {
                const installed = registry.globalRuntime(kind), published = latest.get(kind);
                const update = !!installed && !installed.linked && !!published && runtimeIsOlder(installed.version, published);
                const status = installed?.linked ? "Development link" : !published ? "Unavailable" : !installed ? "Not installed" : update ? "Update available" : "Up to date";
                writeWrapped(prompter, `${packageName(kind)} | installed: ${installed?.version ?? "not installed"} | latest: ${published ?? "unavailable"} | ${status}`);
                return { kind, installed, published, update };
            });
            const updates = rows.filter(row => row.update);
            const available = rows.filter(row => row.published && !row.installed?.linked && (!row.installed || row.update));
            prompter.write("\nDevelopment links are managed in their source checkouts.\n");
            const picked = await prompter.select("Updates", [
                ...available.map(row => ({ value: row.kind, key: row.kind, label: `${row.installed ? "Update" : "Install"} ${packageName(row.kind)}` })),
                ...(updates.length ? [{ value: "all", key: "a", label: `Update all available (${updates.length})` }] : []),
                { value: "refresh", key: "r", label: "Refresh versions" },
                { value: "back", key: "b", label: "Back" },
            ], { cancelValue: "back" });
            if(picked === "back") return;
            if(picked === "refresh") { await refresh(); continue; }
            const selected = picked === "all" ? updates : available.filter(row => row.kind === picked);
            if(!selected.length) continue;
            if(!await prompter.askYesNo(`Install latest published releases for ${selected.map(row => packageName(row.kind)).join(", ")}?`, true)) continue;
            prompter.clearScreen();
            for(const row of selected) {
                writeWrapped(prompter, `Updating ${packageName(row.kind)}...`);
                try {
                    const installed = await registry.installRuntime(row.kind);
                    writeWrapped(prompter, `Installed ${packageName(row.kind)} ${installed.version}.`);
                    const names = Object.entries(registry.read().connections).filter(([, item]) => item.kind === row.kind && item.entry).map(([name]) => name);
                    await registry.checkSaved(prompter, names);
                } catch(error) {
                    let detail = error instanceof Error ? error.message : "Installation failed.";
                    for(const item of Object.values(registry.read().connections)) if(item.entry) detail = redactStartupText(detail, item.entry);
                    writeWrapped(prompter, `FAILED ${packageName(row.kind)}: ${detail}`);
                    if(/\b(?:EBUSY|EPERM|EACCES)\b/i.test(detail)) prompter.write("Close your AI clients, then retry the update. A running runtime may have locked its files.\n");
                }
            }
            prompter.write("Reconnect or restart your AI clients to load updated runtimes. Fix any failed startup checks first.\n");
            await prompter.acknowledge();
        } catch(error) {
            if(error instanceof PromptClosedError) throw error;
            if(error instanceof PromptBackError) continue;
            throw error;
        }
    }
}
