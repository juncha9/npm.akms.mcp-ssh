import { Registry, formatResults, sessionName } from "./registry";
import { CLIENT_LABELS } from "./types";
import { packageName, runtimeInstallCommand, runtimeIsOlder, runtimePrefix } from "./runtime";
import { plainText, writeWrapped } from "./comparison";
import { Prompter, PromptBackError, PromptClosedError } from "./prompter";
import type { McpKind } from "./types";
import { KINDS } from "./types";

export async function prepareRuntime(prompter: Prompter, registry: Registry, kind: McpKind, version?: string): Promise<boolean> {
    const installed = registry.globalRuntime(kind);
    if(installed) {
        if(installed.linked || !version || !runtimeIsOlder(installed.version, version)) return true;
        prompter.clearScreen();
        writeWrapped(prompter, `Installed runtime: ${installed.version}. This setup: ${version}.`);
        if(!await prompter.askYesNo("Update the AKMS runtime to the latest release before continuing?", true)) return true;
    }
    prompter.clearScreen();
    writeWrapped(prompter, `Installing ${packageName(kind)}@latest in ${runtimePrefix()}...`);
    prompter.write("Installation runs during setup. Saved connections will start Node directly.\n");
    try {
        await registry.installRuntime(kind);
        prompter.clearScreen();
        return true;
    } catch(error) {
        prompter.write(`${error instanceof Error ? error.message : "AKMS runtime installation failed."}\n`);
        // A failed npm update may have removed files; only continue with a runtime
        // that is still discoverable, never with a stale pre-install snapshot.
        const available = installed ? registry.globalRuntime(kind) : null;
        if(available) writeWrapped(prompter, `Continuing with installed runtime ${available.version}. You can retry the update from Runtime.`);
        await prompter.acknowledge();
        return Boolean(available);
    }
}

export async function runtimeMenu(prompter: Prompter, registry: Registry, requestedKind?: McpKind): Promise<void> {
    let kind = requestedKind;
    for(;;) {
        prompter.clearScreen();
        if(!kind) {
            const selected = await prompter.select("Runtime / choose MCP", [
                ...KINDS.map((value) => ({ value, label: packageName(value) })),
                { value: "back", key: "b", label: "Back" },
            ], { cancelValue: "back" });
            if(selected === "back") return;
            kind = selected as McpKind;
        }
        try {
            const installed = registry.globalRuntime(kind);
            const sessionMode = registry.isSessionMode(kind);
            writeWrapped(prompter, `Runtime / ${packageName(kind)}`);
            writeWrapped(prompter, installed ? `Installed: ${installed.version}${installed.linked ? " (linked development checkout)" : ""}` : "Not installed in the AKMS runtime directory.");
            writeWrapped(prompter, `Runtime directory: ${runtimePrefix()}`);
            prompter.write("Connections start Node directly, without a resident npm/npx process.\n");
            prompter.write(`Configuration: ${sessionMode ? "one session server for this kind" : "one entry per connection"}.\n`);
            if(installed) writeWrapped(prompter, installed.args[0]);
            const picked = await prompter.select("AKMS runtime", [
                ...(installed && !sessionMode ? [{ value: "apply", label: "Use for existing connections", hint: "convert npx and old runtime paths together" }] : []),
                ...(installed ? [{ value: "catalog", key: "catalog", label: sessionMode ? "Reapply session launch command" : "Switch to session server", hint: `one ${sessionName(kind)} entry per registered service` }] : []),
                ...(sessionMode && (installed || registry.read().sessions?.[kind]) ? [{ value: "individual", key: "individual", label: "Switch back to per-connection entries", hint: "restore connection settings from the catalog" }] : []),
                ...(!installed?.linked ? [{ value: "install", label: installed ? "Update runtime installation" : "Install AKMS runtime", hint: runtimeInstallCommand(kind) }] : []),
                ...(!registry.needsMigration() ? [{ value: "default", key: "default", label: registry.read().defaultMode === "catalog" ? "Use individual entries for new kinds" : "Start new kinds as session servers", hint: "keep existing kinds and rollback choices" }] : []),
                { value: "back", key: "b", label: "Back" },
            ], { cancelValue: "back" });
            if(picked === "back") { if(requestedKind) return; kind = undefined; continue; }
            if(picked === "default") {
                const mode = registry.read().defaultMode === "catalog" ? "individual" : "catalog";
                prompter.write(`New kinds will use ${mode === "catalog" ? "session servers" : "individual entries"}. Existing kinds keep their settings.\n`);
                if(await prompter.askYesNo("Change the default for new kinds?", false)) {
                    prompter.write(`${formatResults(registry.setDefaultMode(mode), "Default for new kinds saved.")}\n`);
                    await prompter.acknowledge();
                }
                continue;
            }
            if(picked === "catalog" || picked === "individual") {
                const plan = registry.planSession(kind, picked);
                prompter.clearScreen();
                writeWrapped(prompter, picked === "catalog" ? `Switch to session server: ${sessionName(kind)}` : "Switch back to per-connection entries");
                prompter.write("Registry version 2 prevents older AKMS setup packages from changing these settings.\nThe previous catalog revision is kept as registry.previous.json.\n\n");
                for(const change of plan.changes) {
                    writeWrapped(prompter, CLIENT_LABELS[change.client]);
                    writeWrapped(prompter, `Apply: ${change.add.join(", ") || "none"}`, "  ");
                    writeWrapped(prompter, `Remove after replacements are applied: ${change.remove.join(", ") || "none"}`, "  ");
                    if(change.review.length) writeWrapped(prompter, `Keep for Sync review: ${change.review.join(", ")}`, "  ");
                }
                if(picked === "catalog") {
                    prompter.write("\nPasswords stay in the catalog and its previous-revision copy. Session entries contain no connection credentials.\n");
                    writeWrapped(prompter, `Command: ${plan.entry.command}`);
                    writeWrapped(prompter, `Runtime: ${plan.entry.args[0]} --catalog`);
                    if(plan.custom.length) {
                        prompter.write("Custom commands will not run in catalog mode; they are retained for switching back:\n");
                        for(const name of plan.custom) writeWrapped(prompter, plainText(name), "  ");
                    }
                } else prompter.write("\nConnection credentials will be copied back into registered client settings. The registry stays version 2.\n");
                if(!await prompter.askYesNo("Apply this configuration mode?", false)) continue;
                const results = registry.applySession(plan);
                prompter.clearScreen();
                prompter.write(`${formatResults(results, "Configuration mode saved.")}\n`);
                await registry.checkSaved(prompter, plan.names);
                prompter.write("Restart or reconnect your AI clients to load the new server layout. Fix startup failures first.\n");
                await prompter.acknowledge();
                continue;
            }
            if(picked === "install") {
                prompter.clearScreen();
                writeWrapped(prompter, `Installing ${packageName(kind)}@latest in ${runtimePrefix()}...`);
                const runtime = await registry.installRuntime(kind);
                prompter.write(`Installed ${runtime.version}. Reconnect your AI clients to load the update.\n`);
                await prompter.acknowledge();
                continue;
            }
            const plan = registry.planRuntime(kind);
            prompter.clearScreen();
            writeWrapped(prompter, `Use AKMS runtime ${packageName(kind)} ${plan.runtime.version}`);
            prompter.write(`\nConvert ${plan.names.length} connection(s):\n`);
            for(const name of plan.names) writeWrapped(prompter, plainText(name), "  ");
            if(plan.skipped.length) {
                prompter.write("Custom commands kept for individual review:\n");
                for(const name of plan.skipped) writeWrapped(prompter, plainText(name), "  ");
            }
            prompter.write("\nConnection values and credentials stay the same.\nVersion-pinned npx entries will use the installed version shown above.\n");
            if(!plan.names.length) {
                prompter.write("No saved launch commands need converting.\nIf a legacy client entry is missing here, import it from Register or Import existing connections first.\n");
                await prompter.acknowledge();
                continue;
            }
            if(!await prompter.askYesNo("Apply these launch commands to registered services?", true)) continue;
            const results = registry.applyRuntime(plan);
            prompter.clearScreen();
            prompter.write(`${formatResults(results, "Runtime settings saved.")}\n\nRestart or reconnect AI clients to replace running npx processes.\n`);
            await registry.checkSaved(prompter, plan.names);
            await prompter.acknowledge();
        } catch(error) {
            if(error instanceof PromptClosedError) throw error;
            if(error instanceof PromptBackError) continue;
            prompter.write(`${error instanceof Error ? error.message : "Could not configure the AKMS runtime."}\n`);
            await prompter.acknowledge();
        }
    }
}
