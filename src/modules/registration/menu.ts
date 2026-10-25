import { Registry, entryHash, entryKind, describeDifferences, formatResults, sessionName } from "./registry";
import { compareEntries, descriptionOnly, plainText, visibleField, writeWrapped } from "./comparison";
import { prepareRuntime, runtimeMenu } from "./runtime-menu";
import { standardLaunch } from "./runtime";
import { updatesMenu } from "./updates-menu";
import { migrationMenu } from "./migration-menu";
export { updatesMenu } from "./updates-menu";
import type { ImportCandidate, SyncResult } from "./registry";
import { CLIENT_LABELS } from "./types";
import type { ClientId, ConfigTarget, McpKind, McpServerEntry } from "./types";
import { Prompter, PromptBackError, PromptClosedError } from "./prompter";
import type { SelectItem } from "./prompter";

export type ManagementMode = "config" | "register" | "sync";

function preview(prompter: Prompter, entry: McpServerEntry | null): void {
    if(!entry) { prompter.write("  Remove this connection from the service.\n"); return; }
    // Arguments may also contain credentials in imported commands. Only env keys and
    // familiar non-secret endpoint fields are shown in a registration/conflict preview.
    for(const [key, value] of Object.entries(entry.env)) prompter.write(`  ${plainText(key)}: ${visibleField.test(key) ? plainText(value) : "(hidden)"}\n`);
}

/** The same screen is bundled in every standalone MCP and in the optional helper. */
export class ManagedSession {
    readonly registry: Registry;
    readonly target: ConfigTarget;
    constructor(readonly options: { kind: McpKind; targets: ConfigTarget[]; registryPath?: string; mode?: ManagementMode; targetId?: string; version?: string; runtimeOptions?: Registry["runtimeOptions"] }) {
        this.registry = new Registry(options.targets, options.registryPath, options.runtimeOptions);
        this.target = this.registry.target(options.kind);
    }

    async initialize(prompter: Prompter): Promise<boolean> {
        const { mode = "config", targetId } = this.options;
        if(targetId && !this.registry.targets.some((item) => item.id === targetId)) throw new Error("Unknown AI service. Use claude-code, codex, claude-desktop or cursor.");
        if(mode === "sync") { await syncMenu(prompter, this.registry); return false; }
        if(mode === "register") {
            await registrationMenu(prompter, this.registry, targetId as ClientId | undefined);
            return false;
        }
        this.registry.read();
        return true;
    }

    writeStatus(prompter: Prompter): void {
        const state = this.registry.read();
        if(this.registry.needsMigration(state)) prompter.write("Registry update available. Choose Migrate registry to review the changes.\n");
        prompter.write(`Services: ${state.clients.map((id) => CLIENT_LABELS[id]).join(" · ") || "none"}\n`);
        if(!state.clients.length) prompter.write("No AI services registered. Choose Register before adding a connection.\n");
        if(this.registry.isSessionMode(this.options.kind, state)) prompter.write(`Session server: ${sessionName(this.options.kind)}. Reconnect clients after changing connections.\n`);
        const attention = new Set(this.registry.inspect().filter((item) => this.registry.kindForName(item.name, state) === this.options.kind
            && !["synced", "removed"].includes(item.status)).map((item) => item.name)).size;
        if(attention) prompter.write(`Needs attention: ${attention} connection(s). Open Sync to review.\n`);
        const pending = this.pendingImports();
        if(pending) prompter.write(`Import existing connections: ${pending} connection(s) available. Existing settings are preserved.\n`);
    }

    private pendingImports(): number {
        const state = this.registry.read();
        return new Set(this.registry.candidates(this.options.kind).entries
            .filter((candidate) => !Object.hasOwn(state.connections, candidate.name))
            .map((candidate) => candidate.name)).size;
    }

    items(): SelectItem<string>[] {
        return [
            { value: "register", key: "register", label: "Register", hint: "AI services shared by all AKMS MCPs" },
            { value: "sync", key: "sync", label: "Sync", hint: "review differences and retry" },
            { value: "import", key: "import", label: "Import existing connections", hint: `${this.pendingImports()} to review` },
            { value: "runtime", key: "runtime", label: "Runtime", hint: "installation / session server / launch commands" },
            { value: "updates", key: "updates", label: "Updates", hint: "installed and latest runtime versions" },
            ...(this.registry.needsMigration() ? [{ value: "migrate", key: "migrate", label: "Migrate registry", hint: "review older registry format and session layout" }] : []),
        ];
    }

    decorate(items: SelectItem<string>[]): void {
        const results = this.registry.inspect();
        for(const item of items) {
            if("separator" in item) continue;
            const separator = item.value.indexOf(":");
            if(separator < 0) continue;
            const name = item.value.slice(separator + 1);
            const rows = results.filter((row) => row.name === name || this.registry.isSessionMode(this.options.kind) && row.name === sessionName(this.options.kind));
            const count = rows.filter((row) => row.status === "synced").length;
            const total = this.registry.read().clients.length;
            const attention = rows.some((row) => !["synced", "removed"].includes(row.status));
            item.hint = [item.hint, total ? `${attention ? "Needs attention" : "Applied"} ${count}/${total}` : "Register to apply"].filter(Boolean).join(" · ");
        }
    }

    async prepareRuntime(prompter: Prompter, existing?: McpServerEntry): Promise<boolean> {
        if(existing && !standardLaunch(existing, this.options.kind)) return true;
        return prepareRuntime(prompter, this.registry, this.options.kind, this.options.version);
    }

    async checkSaved(prompter: Prompter, name: string, before?: McpServerEntry): Promise<void> {
        const saved = this.registry.read().connections[name]?.entry;
        if(saved && (!before || entryHash(saved) !== entryHash(before))) await this.registry.checkSaved(prompter, [name]);
    }

    async handle(action: string, prompter: Prompter): Promise<boolean> {
        if(action === "add" && !this.registry.read().clients.length) {
            prompter.write("\nRegister an AI service first: open Register, select at least one service, then Apply registration.\n");
            await prompter.acknowledge();
            return true;
        }
        if(action === "register") await registrationMenu(prompter, this.registry, this.options.targetId as ClientId | undefined);
        else if(action === "sync") await syncMenu(prompter, this.registry);
        else if(action === "import") await importMenu(prompter, this.registry, this.options.kind);
        else if(action === "runtime") await runtimeMenu(prompter, this.registry, this.options.kind);
        else if(action === "updates") await updatesMenu(prompter, this.registry);
        else if(action === "migrate") await migrationMenu(prompter, this.registry);
        else if(action === "add") return !await this.prepareRuntime(prompter);
        else return false;
        return true;
    }
}

export async function registrationMenu(prompter: Prompter, registry: Registry, initialClient?: ClientId): Promise<boolean> {
    const initial = registry.read();
    const selected = new Set(initial.clients);
    if(initialClient) selected.add(initialClient);
    const discovered = registry.candidates(undefined, registry.targets.filter((target) => target.id !== "registered").map((target) => target.id as ClientId));
    let cursor = initialClient ?? registry.targets[0]?.id;
    let privacyNoticeShown = false;
    for(;;) {
        try {
            prompter.clearScreen();
            prompter.write("\nRegister · AI services\nShared by Database, SSH, WSL and S3.\nEnter toggles a service; Apply saves the selection.\nMatching existing connections are imported on Apply; differing settings stay unchanged.\n\n");
            for(const error of discovered.errors) prompter.write(`  ${error}\n`);
            const picked = await prompter.select<string>("Register", [
                ...registry.targets.filter((target) => target.id !== "registered").map((target) => ({
                    value: target.id, label: `[${selected.has(target.id as ClientId) ? "x" : " "}] ${target.label}`,
                    hint: `${initial.clients.includes(target.id as ClientId) ? "Registered" : "Not registered"} · ${discovered.entries.filter((entry) => entry.client === target.id).length} existing AKMS · ${target.detected ? "Found" : "Not detected"} · ${target.location}`,
                })),
                { separator: true }, { value: "apply", key: "a", label: "Apply registration" },
                { value: "back", key: "q", label: "Back" },
            ], { defaultValue: cursor, cancelValue: "back" });
            if(picked === "back") return false;
            if(picked !== "apply") {
                const client = picked as ClientId;
                if(selected.has(client)) selected.delete(client); else selected.add(client);
                cursor = client;
                continue;
            }
            const removed = initial.clients.filter((id) => !selected.has(id));
            const count = Object.values(registry.read().connections).filter((item) => item.entry).length;
            const plan = registry.planRegistration([...selected]);
            const importNames = [...new Set(plan.imports.map((entry) => entry.name))];
            prompter.clearScreen();
            prompter.write("Review registration\n");
            prompter.write(`\nSelected: ${[...selected].map((id) => CLIENT_LABELS[id]).join(" · ") || "none"}\nApply ${count + importNames.length} shared connection(s) to these services.\n`);
            if(importNames.length) prompter.write(`Import ${importNames.length} existing connection(s); identical copies become one shared item:\n  ${importNames.join("\n  ")}\n`);
            if(plan.conflicts.length) prompter.write(`Keep ${plan.conflicts.length} differing connection(s) unchanged until you choose a version:\n  ${plan.conflicts.join("\n  ")}\n`);
            for(const error of plan.errors) prompter.write(`  ${error}\n`);
            if(initial.defaultMode === "catalog") {
                prompter.write("Services use one session entry per kind. Imported individual entries are removed after that session entry is verified.\n");
                if(plan.imports.some(item => !registry.globalRuntime(item.kind))) prompter.write("Install missing runtimes from Runtime, then run Sync. Existing entries stay until then.\n");
                if(plan.imports.some(item => !standardLaunch(item.entry, item.kind))) prompter.write("Custom launch commands are retained for rollback; session mode uses each connection's saved environment.\n");
            }
            if(removed.length) prompter.write(`Unregister: ${removed.map((id) => CLIENT_LABELS[id]).join(" · ")}\nRemove only AKMS-managed entries from these services; keep the shared catalog.\n`);
            if(!privacyNoticeShown) {
                writeWrapped(prompter, `Connection settings, including passwords, are stored in ${plainText(registry.file)}.`);
                prompter.write("Keep this file private: do not share, sync or commit it.\n");
                prompter.write("Its previous revision, registry.previous.json, also contains saved credentials.\n");
                privacyNoticeShown = true;
            }
            if(!await prompter.askYesNo("Apply this registration?", removed.length === 0)) continue;
            const results = registry.register([...selected], initial.clients, plan.imports);
            prompter.clearScreen();
            prompter.write(`\n${formatResults(results, `Registration saved.\n  AI services: ${[...selected].map((id) => CLIENT_LABELS[id]).join(" · ") || "none"}`)}\n`);
            if(importNames.length) prompter.write(`Imported ${importNames.length} existing connection(s) into the shared list.\n`);
            try {
                const conflicts = new Set(results.filter((result) => result.status === "conflict").map((result) => result.name));
                if(conflicts.size && await prompter.askYesNo(`Compare settings for ${conflicts.size} connection(s) now?`, true)) await syncMenu(prompter, registry);
                const current = registry.read();
                const remaining = registry.candidates().entries.filter((candidate) => !Object.hasOwn(current.connections, candidate.name));
                const names = [...new Set(remaining.map((candidate) => candidate.name))];
                if(names.length) {
                    prompter.write(`\n${names.length} existing connection(s) still need a choice before joining the shared list:\n`);
                    for(const name of names) {
                        const copies = remaining.filter((candidate) => candidate.name === name);
                        prompter.write(`  ${plainText(name)} · ${copies.map((copy) => CLIENT_LABELS[copy.client]).join(" · ")}\n`);
                        if(new Set(copies.map((copy) => entryHash(copy.entry))).size > 1) prompter.write(`    ${describeDifferences(copies.map((copy) => copy.entry))}\n`);
                    }
                    prompter.write("Their existing settings are unchanged. Compare them now, or use Import existing connections later.\n");
                    if(await prompter.askYesNo("Compare existing settings and choose which to share?", true)) await importMenu(prompter, registry);
                }
                if(!conflicts.size && !names.length) await prompter.acknowledge();
            } catch(error) {
                // Registration already succeeded. Esc skips the optional review instead
                // of reopening an obsolete registration draft.
                if(!(error instanceof PromptBackError)) throw error;
            }
            return true;
        } catch(error) {
            if(error instanceof PromptClosedError) throw error;
            if(error instanceof PromptBackError) continue;
            prompter.write(`  ${error instanceof Error ? error.message : "Registration could not be saved."}\n`);
            await prompter.acknowledge();
        }
    }
}

export async function importMenu(prompter: Prompter, registry: Registry, kind?: McpKind): Promise<void> {
    for(;;) {
        prompter.clearScreen();
        prompter.write("Import existing connections\n\n");
        const { entries, errors } = registry.candidates(kind);
        for(const error of errors) prompter.write(`  ${error}\n`);
        const state = registry.read();
        const matching = registry.planRegistration(state.clients, kind);
        const matchingNames = [...new Set(matching.imports.map((entry) => entry.name))];
        const names = [...new Set(entries.filter((candidate) => {
            const current = Object.hasOwn(state.connections, candidate.name) ? state.connections[candidate.name] : undefined;
            return !current?.entry || current.applied[candidate.client] !== entryHash(candidate.entry) || entryHash(current.entry) !== entryHash(candidate.entry);
        }).map((entry) => entry.name))];
        if(!names.length) { prompter.write("  No existing connections need importing.\n"); await prompter.acknowledge(); return; }
        const picked = await prompter.select("Import existing connections", [
            ...names.map((name) => ({ value: `entry:${name}`, key: name, label: name, hint: [...new Set(entries.filter((entry) => entry.name === name).map((entry) => CLIENT_LABELS[entry.client]))].join(" · ") })),
            ...(matchingNames.length ? [{ value: "matching", key: "all", label: "Import all matching connections", hint: `${matchingNames.length} connections; differing versions stay unchanged` }] : []),
            { value: "back", key: "b", label: "Back" },
        ], { cancelValue: "back" });
        if(picked === "back") return;
        try {
            prompter.clearScreen();
            if(picked === "matching") {
                prompter.write(`\nImport existing connections:\n  ${matchingNames.join("\n  ")}\n`);
                if(await prompter.askYesNo("Import matching connections and apply them?", true)) {
                    const results = registry.register(state.clients, state.clients, matching.imports);
                    prompter.clearScreen();
                    prompter.write(`${formatResults(results, "Import complete")}\n`);
                    await prompter.acknowledge();
                }
                continue;
            }
            const name = picked.slice(6);
            const candidates = entries.filter((entry) => entry.name === name);
            let chosen: ImportCandidate = candidates[0];
            if(new Set(candidates.map((candidate) => entryHash(candidate.entry))).size > 1) {
                prompter.write(`\n${plainText(name)} · Choose the settings to use on all registered services.\n`);
                compareEntries(prompter, candidates.map((candidate) => ({ label: CLIENT_LABELS[candidate.client], entry: candidate.entry })));
                const choice = await prompter.select("Use settings from", [
                    ...candidates.map((candidate, index) => ({ value: String(index), label: `Use ${index + 1}: ${CLIENT_LABELS[candidate.client]}` })),
                    { value: "back", label: "Back" },
                ], { cancelValue: "back" });
                if(choice === "back") continue;
                chosen = candidates[Number(choice)];
            }
            preview(prompter, chosen.entry);
            const destination = await prompter.askRequired("Shared connection name (change it to keep both)", name);
            prompter.write("The selected version will be used by every registered service.\n");
            if(!await prompter.askYesNo(`Import ${destination} and apply it?`, true)) continue;
            const results = registry.importEntry(destination, chosen, candidates);
            prompter.clearScreen();
            prompter.write(`\n${formatResults(results, "Import complete")}\n`);
            if(destination !== name) prompter.write("  The original entries were kept under their old name.\n");
            await prompter.acknowledge();
        } catch(error) {
            if(error instanceof PromptClosedError) throw error;
            if(error instanceof PromptBackError) continue;
            prompter.write(`  ${error instanceof Error ? error.message : "Import failed."}\n`);
            await prompter.acknowledge();
        }
    }
}

export async function syncMenu(prompter: Prompter, registry: Registry): Promise<void> {
    let pendingResults: SyncResult[] | undefined;
    for(;;) {
        prompter.clearScreen();
        const results = pendingResults ?? registry.sync();
        pendingResults = undefined;
        prompter.write(`\n${formatResults(results, "Sync results")}\n`);
        const conflicts = results.filter((result) => result.status === "conflict");
        if(!conflicts.length) { await prompter.acknowledge(); return; }
        const picked = await prompter.select("Review differences", [
            ...conflicts.map((item, index) => ({ value: String(index), label: `${CLIENT_LABELS[item.client]} · ${item.name}` })),
            { value: "back", key: "b", label: "Later — keep existing settings" },
        ], { cancelValue: "back" });
        if(picked === "back") return;
        try {
            prompter.clearScreen();
            const conflict = conflicts[Number(picked)];
            const state = registry.read();
            const sessionKind = Object.keys(state.sessions ?? {}).find(kind => sessionName(kind as McpKind) === conflict.name) as McpKind | undefined;
            if(sessionKind) {
                const session = state.sessions![sessionKind]!;
                const actual = registry.targets.find(target => target.id === conflict.client)?.readEntries()[conflict.name];
                if(!actual || entryKind(actual) !== sessionKind) {
                    prompter.write("This session name belongs to an unsupported or different server. Rename the external entry manually; it was kept.\n");
                    await prompter.acknowledge(); continue;
                }
                const removing = !registry.isSessionMode(sessionKind, state) || !state.clients.includes(conflict.client)
                    || !Object.values(state.connections).some(item => item.kind === sessionKind && item.entry);
                writeWrapped(prompter, `Session server / ${conflict.name} / ${CLIENT_LABELS[conflict.client]}`);
                compareEntries(prompter, [{ label: "AKMS session launch", entry: session.entry }, { label: "External settings", entry: actual }]);
                const choice = await prompter.select("Resolve session launch", [
                    { value: "apply", label: removing ? "Remove the old session entry" : "Restore the AKMS session launch" },
                    { value: "back", key: "b", label: "Keep external settings for now" },
                ], { cancelValue: "back" });
                if(choice === "apply" && await prompter.askYesNo(removing ? "Remove this session entry?" : "Replace these external launch settings?", false)) pendingResults = registry.resolve(conflict.client, conflict.name, actual, false);
                continue;
            }
            const connection = state.connections[conflict.name];
            if(!connection) throw new Error("This connection changed. Reopen Sync to review its current settings.");
            const actual = registry.targets.find((target) => target.id === conflict.client)?.readEntries()[conflict.name];
            if(!actual || entryKind(actual) !== connection.kind) {
                prompter.write("  This name belongs to a different or unsupported server. Rename that entry manually, or rename the shared connection.\n");
                await prompter.acknowledge();
                continue;
            }
            const client = CLIENT_LABELS[conflict.client];
            const registered = state.clients.includes(conflict.client);
            const sessionMode = registry.isSessionMode(connection.kind, state);
            const removing = !connection.entry || !registered || sessionMode;
            const subject = connection.entry && descriptionOnly([connection.entry, actual]) ? "description" : "settings";
            writeWrapped(prompter, `Sync / ${plainText(conflict.name)}`);
            writeWrapped(prompter, `Registered services: ${state.clients.map((id) => CLIENT_LABELS[id]).join(" · ") || "none"}`);
            prompter.write("\n");
            if(!removing && connection.entry) {
                compareEntries(prompter, [{ label: "Saved in AKMS", entry: connection.entry }, { label: `Currently in ${client}`, entry: actual }]);
            } else {
                writeWrapped(prompter, !registered ? `${client} is no longer registered.` : sessionMode ? `This kind now uses ${sessionName(connection.kind)}. The individual client entry is no longer needed.` : "This connection was removed from AKMS.");
                writeWrapped(prompter, `Its settings in ${client} changed before removal could finish.`);
                prompter.write(`\nCurrently in ${client}\n`); preview(prompter, actual);
                prompter.write("\n");
            }
            const choices: SelectItem<string>[] = [
                { value: "shared", label: removing ? `Remove from ${client}` : `Use 1: AKMS -> ${client}`, hint: removing ? "finish the pending removal" : `replace its ${subject} with version 1` },
                ...(registered ? [{ value: "client", label: sessionMode ? `Import ${client} settings into the catalog, then remove this entry` : removing ? `Restore from ${client}` : `Use 2: ${client} -> all ${state.clients.length} services`, hint: "save in AKMS and sync registered services" }] : []),
                { value: "back", key: "b", label: "Back without changes" },
            ];
            const choice = await prompter.select(removing ? (registered ? "Remove or restore this connection?" : `Remove this connection from ${client}?`) : `Which ${subject} should be used?`, choices, { cancelValue: "back" });
            if(choice === "back") continue;
            prompter.write("\n");
            if(choice === "client") {
                writeWrapped(prompter, `Save the ${client} version in AKMS.`);
                writeWrapped(prompter, `Sync to: ${state.clients.map((id) => CLIENT_LABELS[id]).join(" · ")}`);
            } else writeWrapped(prompter, removing ? `Remove ${plainText(conflict.name)} from ${client}.` : `Copy the saved AKMS ${subject} to ${client}.`);
            const confirmation = choice === "client" ? `Save in AKMS and sync ${state.clients.length} services?`
                : removing ? `Remove from ${client}?` : `Update ${client} with version 1?`;
            if(await prompter.askYesNo(confirmation, false)) {
                pendingResults = registry.resolve(conflict.client, conflict.name, actual, choice === "client");
            }
        } catch(error) {
            if(error instanceof PromptClosedError) throw error;
            if(error instanceof PromptBackError) continue;
            prompter.write(`  ${error instanceof Error ? error.message : "Could not resolve the difference."}\n`);
            await prompter.acknowledge();
        }
    }
}
