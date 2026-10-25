import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { updateConfigFile } from "./config-file";
import { CLIENT_LABELS, KINDS } from "./types";
import { findGlobalRuntime, installGlobalRuntime, latestRuntimeVersion, launchKind, runtimeInstallCommand, standardLaunch, catalogLaunch } from "./runtime";
import type { GlobalRuntime } from "./runtime";
import { checkConnections, checkStartup } from "./startup-check";
import type { Prompter } from "./prompter";
import { defaultCatalogPath, maxConnectionNameLength } from "./catalog";
import type { ClientId, ConfigTarget, ConfigWriteResult, McpKind, McpServerEntry } from "./types";

interface Connection {
    kind: McpKind;
    entry: McpServerEntry | null;
    /** Hashes of the last applied owned fields, never extra client-specific options. */
    applied: Partial<Record<ClientId, string>>;
    replacement?: string;
}
export interface RegistryState {
    version: 1 | 2;
    /** Only new catalogs opt in; older v2 catalogs keep their per-kind choices. */
    defaultMode?: "catalog" | "individual";
    clients: ClientId[];
    connections: Record<string, Connection>;
    sessions?: Partial<Record<McpKind, { mode: "catalog" | "individual"; entry: McpServerEntry; applied: Partial<Record<ClientId, string>> }>>;
}
export const sessionName = (kind: McpKind): string => `akms_${kind}`;
export interface SessionPlan {
    kind: McpKind;
    mode: "catalog" | "individual";
    expected: string;
    entry: McpServerEntry;
    names: string[];
    custom: string[];
    changes: { client: ClientId; add: string[]; remove: string[]; review: string[] }[];
}
export interface MigrationPlan {
    expected: string;
    steps: { id: string; label: string }[];
    kinds: { kind: McpKind; status: "convert" | "catalog" | "individual" | "pending-runtime" | "empty" | "blocked"; names: string[]; session?: SessionPlan; changes?: SessionPlan["changes"]; detail?: string }[];
}
// Keep steps ordered as new registry formats are introduced.
const MIGRATION_STEPS = [
    { id: "v1_to_v2", label: "Upgrade registry version 1 to version 2", needed: (state: RegistryState) => state.version === 1 },
    { id: "catalog_default", label: "Record catalog mode as the default for new kinds", needed: (state: RegistryState) => state.defaultMode === undefined },
];
export interface SyncResult {
    client: ClientId;
    name: string;
    status: "synced" | "removed" | "pending" | "conflict" | "error";
    detail: string;
}
export interface ImportCandidate { client: ClientId; name: string; kind: McpKind; entry: McpServerEntry }
export interface RegistrationPlan {
    imports: ImportCandidate[];
    conflicts: string[];
    errors: string[];
}
export interface RuntimePlan {
    kind: McpKind;
    runtime: GlobalRuntime;
    names: string[];
    skipped: string[];
    expected: string;
}

const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const validEntry = (value: unknown): value is McpServerEntry => record(value)
    && typeof value.command === "string" && Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")
    && record(value.env) && Object.values(value.env).every((item) => typeof item === "string");

export class RegistryError extends Error {}

export function entryHash(entry: McpServerEntry): string {
    return createHash("sha256").update(JSON.stringify([entry.command, entry.args, Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}

/** Field names only: command arguments and environment values may contain secrets. */
export function differingFields(entries: McpServerEntry[]): string[] {
    if(entries.length < 2) return [];
    const fields: string[] = [];
    if(new Set(entries.map((entry) => entry.command)).size > 1) fields.push("command");
    if(new Set(entries.map((entry) => JSON.stringify(entry.args))).size > 1) fields.push("args");
    for(const key of new Set(entries.flatMap((entry) => Object.keys(entry.env)))) {
        if(new Set(entries.map((entry) => own(entry.env, key) ? entry.env[key] : undefined)).size > 1) fields.push(`env.${key}`);
    }
    return fields;
}

export function describeDifferences(entries: McpServerEntry[]): string {
    const fields = differingFields(entries);
    if(fields.length && fields.every((field) => /^env\.(DB|SSH|WSL|S3)_DESCRIPTION$/.test(field))) return "Only the description differs; connection settings match.";
    return `Different fields: ${fields.map((field) => field.replace(/^env\./, "").replace(/[\x00-\x1f\x7f]/g, " ")).join(", ")}.`;
}

export function entryKind(entry: McpServerEntry): McpKind | null {
    return launchKind(entry);
}

export function defaultRegistryPath(): string {
    return defaultCatalogPath();
}

/** One local catalog, created by any standalone package. The launcher is never invoked. */
export class Registry {
    readonly file: string;
    private observedText: string | null | undefined;
    private backupCaptured = false;
    constructor(readonly targets: ConfigTarget[], file = defaultRegistryPath(), readonly runtimeOptions: {
        find?: (kind: McpKind) => GlobalRuntime | null;
        install?: (kind: McpKind) => Promise<void>;
        check?: typeof checkStartup;
        latest?: typeof latestRuntimeVersion;
    } = {}) { this.file = file; }

    globalRuntime(kind: McpKind): GlobalRuntime | null { return (this.runtimeOptions.find ?? findGlobalRuntime)(kind); }

    latestRuntime(kind: McpKind): Promise<string | null> { return (this.runtimeOptions.latest ?? latestRuntimeVersion)(kind); }

    isSessionMode(kind: McpKind, state = this.read()): boolean { return state.version === 2 && (state.sessions?.[kind]?.mode ?? state.defaultMode) === "catalog"; }

    needsMigration(state = this.read()): boolean { return MIGRATION_STEPS.some(step => step.needed(state)); }

    planMigration(): MigrationPlan {
        const state = this.read();
        const steps = MIGRATION_STEPS.filter(step => step.needed(state)).map(({ id, label }) => ({ id, label }));
        const kinds: MigrationPlan["kinds"] = steps.length ? KINDS.map(kind => {
            const names = Object.entries(state.connections).filter(([, item]) => item.kind === kind && item.entry).map(([name]) => name);
            if(state.sessions?.[kind]?.mode === "individual") return { kind, names, status: "individual" };
            if(this.isSessionMode(kind, state)) return { kind, names, status: "catalog" };
            if(!names.length) return { kind, names, status: "empty" };
            try {
                for(const name of names) this.validateName(kind, name);
                if(!this.globalRuntime(kind)) {
                    const changes = state.clients.map(client => {
                        const remove = names.filter(name => state.connections[name].applied[client]);
                        const review: string[] = [];
                        try {
                            const target = this.targets.find(item => item.id === client);
                            if(!target) throw new Error();
                            const entries = target.readEntries();
                            if(target.hasEntry?.(sessionName(kind)) ?? own(entries, sessionName(kind))) review.push(sessionName(kind));
                            for(const name of remove) if((target.hasEntry?.(name) ?? own(entries, name)) && (!entries[name] || entryHash(entries[name]) !== state.connections[name].applied[client])) review.push(name);
                        } catch { review.push("Cannot inspect this service; Sync will retry."); }
                        return { client, add: [sessionName(kind)], remove, review };
                    });
                    return { kind, names, status: "pending-runtime", changes, detail: "Install from Runtime, then run Sync. Existing entries stay until the session is verified." };
                }
                return { kind, names, status: "convert", session: this.sessionPlan(kind, "catalog", state) };
            } catch(error) { return { kind, names, status: "blocked", detail: error instanceof RegistryError ? error.message : "Cannot preview this kind. Check its runtime and catalog settings." }; }
        }) : [];
        return { expected: JSON.stringify(state), steps, kinds };
    }

    applyMigration(plan: MigrationPlan): SyncResult[] {
        if(!plan.steps.length) return this.locked(() => {
            if(JSON.stringify(this.read()) !== plan.expected) throw new RegistryError("The catalog changed since review. Reopen Migrate registry.");
            return [];
        });
        return this.change(state => {
            if(JSON.stringify(state) !== plan.expected) throw new RegistryError("The catalog changed since review. Reopen Migrate registry.");
            if(plan.kinds.some(item => item.status === "blocked")) throw new RegistryError("Resolve blocked kinds before migrating the registry.");
            for(const item of plan.kinds) {
                if(item.status === "pending-runtime" && this.globalRuntime(item.kind)) throw new RegistryError("Runtime availability changed since review. Reopen Migrate registry.");
                if(item.session) this.applySessionState(state, item.session, false);
            }
            for(const step of plan.steps) {
                if(step.id === "v1_to_v2") { state.version = 2; state.sessions ??= {}; }
                else if(step.id === "catalog_default") state.defaultMode = "catalog";
                else throw new RegistryError("Unknown registry migration step. Reopen Migrate registry.");
            }
        }, plan.kinds.filter(item => item.status === "convert" || item.status === "pending-runtime").map(item => item.kind));
    }

    setDefaultMode(mode: "catalog" | "individual"): SyncResult[] {
        return this.change(state => {
            if(state.version !== 2 || state.defaultMode === undefined) throw new RegistryError("Migrate registry before changing the default for new kinds.");
            if(state.defaultMode === mode) return;
            // Freeze existing implicit choices before changing the future-kind default.
            for(const kind of KINDS) if(!state.sessions?.[kind] && Object.values(state.connections).some(item => item.kind === kind && item.entry)) {
                if(!this.globalRuntime(kind)) throw new RegistryError("Set up the pending runtimes and run Sync before changing the default for new kinds.");
                state.sessions ??= {};
                state.sessions[kind] = { mode: this.isSessionMode(kind, state) ? "catalog" : "individual", entry: this.sessionEntry(kind), applied: {} };
            }
            state.defaultMode = mode;
        }, []);
    }

    kindForName(name: string, state = this.read()): McpKind | undefined {
        return own(state.connections, name) ? state.connections[name].kind : KINDS.find(kind => sessionName(kind) === name && (state.sessions?.[kind] || this.isSessionMode(kind, state)));
    }

    private validateName(kind: McpKind, name: string): void {
        if(!/^[A-Za-z0-9_-]+$/.test(name) || name.length > maxConnectionNameLength(kind)) throw new RegistryError(`Connection names must use 1-${maxConnectionNameLength(kind)} ASCII letters, digits, underscores or hyphens for ${kind.toUpperCase()}. Rename this connection before saving.`);
        if(KINDS.some(value => sessionName(value) === name)) throw new RegistryError("Names akms_db, akms_ssh, akms_wsl and akms_s3 are reserved for session servers. Choose another name.");
    }

    sessionEntry(kind: McpKind): McpServerEntry {
        if(path.basename(this.file) !== "registry.json") throw new RegistryError("Session mode requires a catalog named registry.json in the AKMS catalog directory.");
        const runtime = this.requireRuntime(kind);
        const env: Record<string, string> = {};
        if(process.env.AKMS_MCP_HOME || path.resolve(this.file) !== path.resolve(defaultCatalogPath())) env.AKMS_MCP_HOME = path.dirname(path.resolve(this.file));
        return { command: runtime.command, args: [...runtime.args, "--catalog"], env };
    }

    planSession(kind: McpKind, mode: "catalog" | "individual"): SessionPlan {
        return this.sessionPlan(kind, mode, this.read());
    }

    private sessionPlan(kind: McpKind, mode: "catalog" | "individual", state: RegistryState): SessionPlan {
        const names = Object.entries(state.connections).filter(([, item]) => item.kind === kind && item.entry).map(([name]) => name);
        for(const name of names) this.validateName(kind, name);
        if(own(state.connections, sessionName(kind))) throw new RegistryError("Rename the connection using the reserved session server name before switching modes.");
        const entry = mode === "catalog" ? this.sessionEntry(kind) : state.sessions?.[kind]?.entry
            ?? (this.isSessionMode(kind, state) && this.globalRuntime(kind) ? this.sessionEntry(kind) : undefined);
        if(!entry) throw new RegistryError("This kind has no session server to switch back from.");
        const changes = state.clients.map(client => {
            const target = this.targets.find(item => item.id === client);
            const add = mode === "catalog" ? (names.length ? [sessionName(kind)] : []) : names;
            const remove = mode === "catalog" ? Object.keys(state.connections).filter(name => state.connections[name].kind === kind && state.connections[name].applied[client]) : [sessionName(kind)];
            const review: string[] = [];
            try {
                if(!target) throw new Error();
                const actual = target.readEntries();
                for(const name of [...new Set([...add, ...remove])]) {
                    const prior = name === sessionName(kind) ? state.sessions?.[kind]?.applied[client] : state.connections[name]?.applied[client];
                    const wanted = mode === "catalog" && name === sessionName(kind) ? entry : mode === "individual" ? state.connections[name]?.entry : null;
                    if((target.hasEntry?.(name) ?? own(actual, name)) && (!actual[name] || entryHash(actual[name]) !== prior && (!wanted || entryHash(actual[name]) !== entryHash(wanted)))) review.push(name);
                }
            } catch { review.push("Cannot inspect this service; Sync will retry."); }
            return { client, add, remove, review };
        });
        return { kind, mode, entry, expected: JSON.stringify(state), names, changes, custom: names.filter(name => !standardLaunch(state.connections[name].entry!, kind)) };
    }

    applySession(plan: SessionPlan): SyncResult[] {
        return this.change(state => this.applySessionState(state, plan));
    }

    private applySessionState(state: RegistryState, plan: SessionPlan, checkSnapshot = true): void {
        if(checkSnapshot && JSON.stringify(state) !== plan.expected) throw new RegistryError("The catalog changed since review. Reopen Runtime before switching modes.");
        if(plan.mode === "catalog" && entryHash(this.sessionEntry(plan.kind)) !== entryHash(plan.entry)) throw new RegistryError("The runtime changed since review. Reopen Runtime before switching modes.");
        state.version = 2; state.sessions ??= {};
        state.sessions[plan.kind] = { mode: plan.mode, entry: plan.entry, applied: state.sessions[plan.kind]?.applied ?? {} };
    }

    async checkSaved(prompter: Prompter, names: string[]): Promise<void> {
        const state = this.read();
        const entries: { name: string; entry: McpServerEntry; prefixes?: string[]; maskEntries?: McpServerEntry[] }[] = [];
        const sessions = new Set<McpKind>();
        for(const name of new Set(names)) {
            const connection = state.connections[name];
            if(!connection?.entry) continue;
            if(this.isSessionMode(connection.kind, state)) sessions.add(connection.kind);
            else entries.push({ name, entry: connection.entry });
        }
        for(const kind of sessions) {
            const entry = state.sessions?.[kind]?.entry;
            if(!entry) { prompter.write(`Startup check pending for ${sessionName(kind)}: install its runtime from Runtime, then run Sync.\n`); continue; }
            entries.push({ name: sessionName(kind), entry,
                prefixes: Object.entries(state.connections).filter(([, item]) => item.kind === kind && item.entry).map(([name]) => `${name}__`),
                maskEntries: Object.values(state.connections).filter(item => item.kind === kind && item.entry).map(item => item.entry!) });
        }
        await checkConnections(prompter, entries, this.runtimeOptions.check);
    }

    async installRuntime(kind: McpKind): Promise<GlobalRuntime> {
        if(this.globalRuntime(kind)?.linked) throw new RegistryError("This is a linked development installation. Build or update its source checkout instead.");
        await (this.runtimeOptions.install ?? installGlobalRuntime)(kind);
        return this.requireRuntime(kind);
    }

    private requireRuntime(kind: McpKind): GlobalRuntime {
        const runtime = this.globalRuntime(kind);
        if(!runtime) throw new RegistryError(`Install the AKMS runtime first: ${runtimeInstallCommand(kind)}. Then reopen Runtime.`);
        return runtime;
    }

    private runtimeSnapshot(state: RegistryState, kind: McpKind): string {
        return JSON.stringify([state.clients, Object.entries(state.connections).filter(([, item]) => item.kind === kind)
            .map(([name, item]) => [name, item.entry ? entryHash(item.entry) : null]).sort(([a], [b]) => String(a).localeCompare(String(b)))]);
    }

    planRuntime(kind: McpKind): RuntimePlan {
        const state = this.read();
        const runtime = this.requireRuntime(kind);
        const names: string[] = [], skipped: string[] = [];
        for(const [name, item] of Object.entries(state.connections)) {
            if(item.kind !== kind || !item.entry) continue;
            if(!standardLaunch(item.entry, kind)) { skipped.push(name); continue; }
            if(item.entry.command !== runtime.command || JSON.stringify(item.entry.args) !== JSON.stringify(runtime.args)) names.push(name);
        }
        return { kind, runtime, names, skipped, expected: this.runtimeSnapshot(state, kind) };
    }

    applyRuntime(plan: RuntimePlan): SyncResult[] {
        return this.change((state) => {
            if(this.runtimeSnapshot(state, plan.kind) !== plan.expected) throw new RegistryError("Connections or registration changed since review. Reopen Runtime before applying.");
            const runtime = this.requireRuntime(plan.kind);
            if(JSON.stringify(runtime) !== JSON.stringify(plan.runtime)) throw new RegistryError("The global installation changed since review. Reopen Runtime before applying.");
            for(const name of plan.names) {
                const item = state.connections[name];
                if(!item?.entry || item.kind !== plan.kind || !standardLaunch(item.entry, plan.kind)) throw new RegistryError("This connection has a custom launch command. Review it individually.");
                item.entry = { ...item.entry, command: runtime.command, args: [...runtime.args] };
            }
        });
    }

    read(): RegistryState {
        let text: string;
        try { text = fs.readFileSync(this.file, "utf8"); this.observedText = text; }
        catch(error) {
            if((error as NodeJS.ErrnoException).code === "ENOENT") { this.observedText = null; return { version: 2, defaultMode: "catalog", clients: [], connections: {}, sessions: {} }; }
            throw new RegistryError("Cannot read the AKMS registry. Check its permissions.");
        }
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw new RegistryError("Invalid AKMS registry JSON; the file was not changed."); }
        if(!record(value) || ![1, 2].includes(value.version as number)) throw new RegistryError("Unsupported AKMS registry version; update this MCP package before changing it.");
        if(!Array.isArray(value.clients) || !value.clients.every((id) => typeof id === "string" && own(CLIENT_LABELS, id))
            || new Set(value.clients).size !== value.clients.length || !record(value.connections)) throw new RegistryError("Invalid AKMS registry; the file was not changed.");
        for(const [name, connection] of Object.entries(value.connections)) {
            if(!name.trim() || !record(connection) || !KINDS.includes(connection.kind as McpKind)
                || !(connection.entry === null || validEntry(connection.entry)) || !record(connection.applied)
                || Object.entries(connection.applied).some(([id, hash]) => !own(CLIENT_LABELS, id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
                || (connection.replacement != null && typeof connection.replacement !== "string")) throw new RegistryError("Invalid AKMS registry entry; the file was not changed.");
        }
        if(value.version === 2) {
            if(!record(value.sessions) || value.defaultMode !== undefined && !["catalog", "individual"].includes(value.defaultMode as string)) throw new RegistryError("Invalid session server state; the file was not changed.");
            for(const [kind, session] of Object.entries(value.sessions)) {
                if(!KINDS.includes(kind as McpKind) || !record(session) || !["catalog", "individual"].includes(session.mode as string)
                    || !validEntry(session.entry) || !catalogLaunch(session.entry, kind as McpKind) || Object.keys(session.entry.env).some(key => key !== "AKMS_MCP_HOME") || !record(session.applied)
                    || Object.entries(session.applied).some(([id, hash]) => !own(CLIENT_LABELS, id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new RegistryError("Invalid session server state; the file was not changed.");
                if(own(value.connections, sessionName(kind as McpKind))) throw new RegistryError("A connection uses a reserved session server name; the file was not changed.");
            }
        } else if(value.sessions !== undefined || value.defaultMode !== undefined) throw new RegistryError("Session server state requires registry version 2; the file was not changed.");
        return value as unknown as RegistryState;
    }

    private save(state: RegistryState): void {
        const after = JSON.stringify(state, null, 2) + "\n";
        updateConfigFile(this.file, (before) => {
            if(this.observedText !== undefined && before !== (this.observedText ?? "")) throw new RegistryError("The AKMS catalog changed outside this command. Reload it and retry Sync.");
            return after;
        }, { beforeCommit: before => {
            if(before !== null && !this.backupCaptured) {
                updateConfigFile(path.join(path.dirname(this.file), "registry.previous.json"), () => before, { mode: fs.statSync(this.file).mode & 0o777 });
                this.backupCaptured = true;
            }
        } });
        this.observedText = after;
    }

    /** Serializes standalone editors across packages, including their config-file writes. */
    private locked<T>(action: () => T): T {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const lock = this.file + ".lock";
        let descriptor: number;
        try { descriptor = fs.openSync(lock, "wx", 0o600); }
        catch(error) {
            if((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // A killed CLI cannot release its lock. Only reclaim a lock whose PID is gone.
            let abandoned = false;
            try {
                const pid = Number(fs.readFileSync(lock, "utf8"));
                if(Number.isSafeInteger(pid) && pid > 0) {
                    try { process.kill(pid, 0); } catch(probe) { abandoned = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
                }
            } catch { /* Another editor may still be creating it. */ }
            if(!abandoned) throw new RegistryError("Another AKMS configuration command is running. Finish it and retry.");
            fs.unlinkSync(lock);
            descriptor = fs.openSync(lock, "wx", 0o600);
        }
        this.backupCaptured = false;
        try { fs.writeFileSync(descriptor, String(process.pid)); return action(); }
        finally { this.backupCaptured = false; fs.closeSync(descriptor); fs.unlinkSync(lock); }
    }

    private change(action: (state: RegistryState) => void, kinds?: McpKind[]): SyncResult[] {
        return this.locked(() => {
            const state = this.read();
            action(state);
            // A new kind inherits the new catalog's default only when its runtime
            // is available. Imported legacy entries stay intact while it is missing.
            for(const kind of KINDS) {
                if(this.isSessionMode(kind, state) && !state.sessions?.[kind]
                    && Object.values(state.connections).some(item => item.kind === kind && item.entry) && this.globalRuntime(kind)) {
                    state.sessions ??= {};
                    state.sessions[kind] = { mode: "catalog", entry: this.sessionEntry(kind), applied: {} };
                }
            }
            // Persist desired state before touching any client: failures remain retryable.
            this.save(state);
            return this.reconcile(state, true, kinds);
        });
    }

    register(clients: ClientId[], expected?: ClientId[], imports: ImportCandidate[] = []): SyncResult[] {
        if(clients.some((id) => !own(CLIENT_LABELS, id))) throw new RegistryError("Unknown AI service.");
        return this.change((state) => {
            if(expected && JSON.stringify(state.clients) !== JSON.stringify(expected)) throw new RegistryError("Registration changed in another command. Reopen Register before applying.");
            const grouped = new Map<string, ImportCandidate[]>();
            for(const candidate of imports) grouped.set(candidate.name, [...grouped.get(candidate.name) ?? [], candidate]);
            for(const [name, candidates] of grouped) {
                if(own(state.connections, name)) throw new RegistryError("The shared catalog changed since review. Reopen Register or Import before applying.");
                const chosen = candidates[0];
                this.validateName(chosen.kind, name);
                const applied: Partial<Record<ClientId, string>> = {};
                for(const candidate of candidates) {
                    if(!clients.includes(candidate.client) || candidate.kind !== chosen.kind || entryKind(candidate.entry) !== chosen.kind
                        || entryHash(candidate.entry) !== entryHash(chosen.entry)) throw new RegistryError("Different existing settings need an explicit choice before import.");
                    const actual = this.targets.find((target) => target.id === candidate.client)?.readEntries()[name];
                    if(!actual || entryHash(actual) !== entryHash(candidate.entry)) throw new RegistryError("Existing settings changed since review. Reopen Register or Import before applying.");
                    applied[candidate.client] = entryHash(actual);
                }
                Object.defineProperty(state.connections, name, { value: { kind: chosen.kind, entry: chosen.entry, applied }, enumerable: true, configurable: true, writable: true });
            }
            state.clients = [...new Set(clients)];
        });
    }

    /** Discover without writing. Only unambiguous, previously unmanaged names are batched. */
    planRegistration(clients: ClientId[], kind?: McpKind): RegistrationPlan {
        const state = this.read();
        const { entries, errors } = this.candidates(kind, clients);
        const groups = new Map<string, ImportCandidate[]>();
        for(const entry of entries) groups.set(entry.name, [...groups.get(entry.name) ?? [], entry]);
        const imports: ImportCandidate[] = [];
        const conflicts: string[] = [];
        for(const [name, candidates] of groups) {
            if(own(state.connections, name)) continue; // Never resurrect a pending deletion.
            try { this.validateName(candidates[0].kind, name); } catch { conflicts.push(name); continue; }
            if(new Set(candidates.map((candidate) => entryHash(candidate.entry))).size === 1) imports.push(...candidates);
            else conflicts.push(name);
        }
        return { imports, conflicts, errors };
    }

    write(kind: McpKind, name: string, entry: McpServerEntry, oldName?: string, expected?: string | null): SyncResult[] {
        this.validateName(kind, name);
        if(!validEntry(entry) || entryKind(entry) !== kind || catalogLaunch(entry)) throw new RegistryError("Invalid connection name or MCP entry.");
        return this.change((state) => {
            if(!state.clients.length) throw new RegistryError("Register at least one AI service before saving a connection.");
            const observedName = oldName ?? name;
            const observed = own(state.connections, observedName) ? state.connections[observedName].entry : null;
            if(expected !== undefined && (observed ? entryHash(observed) : null) !== expected) throw new RegistryError("This connection changed while the form was open. Reload it before saving.");
            const previous = own(state.connections, name) ? state.connections[name] : undefined;
            if(previous && previous.kind !== kind) throw new RegistryError(`The name ${name} is already used by another MCP. Choose another name.`);
            if(oldName && oldName !== name && previous) throw new RegistryError(`The name ${name} already exists. Choose another name.`);
            if(oldName && oldName !== name) {
                const old = own(state.connections, oldName) ? state.connections[oldName] : undefined;
                if(!old || old.kind !== kind || !old.entry) throw new RegistryError("The connection changed; reload before renaming it.");
                old.entry = null;
                old.replacement = name;
            }
            Object.defineProperty(state.connections, name, { value: { kind, entry, applied: previous?.applied ?? {} }, enumerable: true, configurable: true, writable: true });
        });
    }

    remove(kind: McpKind, name: string, expected?: string | null): SyncResult[] {
        return this.change((state) => {
            const observed = own(state.connections, name) ? state.connections[name].entry : null;
            if(expected !== undefined && (observed ? entryHash(observed) : null) !== expected) throw new RegistryError("This connection changed since it was displayed. Reload it before removing it.");
            if(!own(state.connections, name)) return;
            if(state.connections[name].kind !== kind) throw new RegistryError("This connection belongs to another MCP.");
            state.connections[name].entry = null;
        });
    }

    sync(): SyncResult[] { return this.change(() => {}); }
    inspect(): SyncResult[] { return this.reconcile(this.read(), false); }

    private reconcile(state: RegistryState, apply: boolean, kinds?: McpKind[]): SyncResult[] {
        const results: SyncResult[] = [];
        // New names must be installed before old names can be removed on that client.
        const active = (kind: McpKind) => Object.entries(state.connections).filter(([, item]) => item.kind === kind && item.entry);
        for(const kind of kinds ?? KINDS) if(this.isSessionMode(kind, state) && active(kind).length && !state.sessions?.[kind]) {
            for(const client of state.clients) results.push({ client, name: sessionName(kind), status: "pending", detail: "Install this kind's runtime from Runtime, then run Sync. Existing client entries are kept." });
        }
        const work = [
            ...Object.entries(state.connections).filter(([, connection]) => !kinds || kinds.includes(connection.kind)).map(([name, connection]) => ({ name, connection, bundle: false })),
            ...(kinds ?? KINDS).flatMap(kind => state.sessions?.[kind] ? [{ name: sessionName(kind), bundle: true, connection: { kind, entry: state.sessions[kind]!.entry, applied: state.sessions[kind]!.applied } as Connection }] : []),
        ];
        const wanted = (item: typeof work[number]) => item.bundle ? (this.isSessionMode(item.connection.kind, state) && active(item.connection.kind).length ? item.connection.entry : null)
            : this.isSessionMode(item.connection.kind, state) ? null : item.connection.entry;
        // Install the replacement representation first, then remove the old one.
        work.sort((a, b) => (wanted(a) ? 0 : a.bundle ? 2 : 1) - (wanted(b) ? 0 : b.bundle ? 2 : 1));
        for(const item of work) {
            const { name, connection, bundle } = item;
            const clients = new Set([...state.clients, ...Object.keys(connection.applied) as ClientId[]]);
            for(const client of clients) {
                const desired = state.clients.includes(client) ? wanted(item) : null;
                const previous = connection.applied[client];
                if(!desired && !previous) continue;
                const target = this.targets.find((candidate) => candidate.id === client);
                const report = (status: SyncResult["status"], detail: string) => results.push({ client, name, status, detail });
                if(!target) { report("error", "Service adapter unavailable; use a newer package to retry."); continue; }
                try {
                    const entries = target.readEntries();
                    const actual = own(entries, name) ? entries[name] : undefined;
                    const exists = target.hasEntry?.(name) ?? actual != null;
                    const hash = actual ? entryHash(actual) : undefined;
                    if(desired && hash === entryHash(desired)) {
                        if(apply) connection.applied[client] = hash;
                        report("synced", "Up to date");
                    }
                    else if(!desired && !exists) {
                        if(apply) delete connection.applied[client];
                        report("removed", "Removed");
                    }
                    else if(exists && (!actual || !previous || hash !== previous)) {
                        report("conflict", actual && desired ? describeDifferences([desired, actual])
                            : actual ? "Changed outside AKMS; review before removing this entry."
                            : "This name is used by another server type; choose another name.");
                    }
                    else if(!apply) {
                        report("pending", desired ? "Needs applying" : "Needs removal");
                    }
                    else {
                        if(!desired && state.clients.includes(client)) {
                            if(!bundle && this.isSessionMode(connection.kind, state) && active(connection.kind).length) {
                                const session = state.sessions?.[connection.kind];
                                const replacement = entries[sessionName(connection.kind)];
                                if(!session || !replacement || entryHash(replacement) !== entryHash(session.entry) || session.applied[client] !== entryHash(session.entry)) {
                                    report("pending", "Connection entry kept until the session server is applied."); continue;
                                }
                            }
                            if(bundle && !this.isSessionMode(connection.kind, state) && active(connection.kind).some(([connectionName, value]) => !entries[connectionName] || entryHash(entries[connectionName]) !== entryHash(value.entry!))) {
                                report("pending", "Session entry kept until all connection entries are applied."); continue;
                            }
                        }
                        let replacement = connection.replacement && state.connections[connection.replacement];
                        const visited = new Set<string>();
                        while(replacement && !replacement.entry && replacement.replacement && !visited.has(replacement.replacement)) {
                            visited.add(replacement.replacement);
                            replacement = state.connections[replacement.replacement];
                        }
                        if(!desired && state.clients.includes(client) && !this.isSessionMode(connection.kind, state) && replacement && replacement.entry
                            && replacement.applied[client] !== entryHash(replacement.entry)) {
                            report("pending", "Old name kept until the new name is applied.");
                            continue;
                        }
                        const result = desired ? target.writeEntry(name, desired) : target.removeEntry(name);
                        if(result.status !== "written") { report("error", "Could not write this service's settings. Check its CLI, syntax and permissions."); continue; }
                        // Read back, so success means the requested entry really reached disk.
                        const after = target.readEntries()[name];
                        if(desired ? !after || entryHash(after) !== entryHash(desired) : (target.hasEntry?.(name) ?? after != null)) {
                            report("error", "Settings could not be verified; retry Sync."); continue;
                        }
                        if(desired) connection.applied[client] = entryHash(desired); else delete connection.applied[client];
                        report(desired ? "synced" : "removed", desired ? "Applied" : "Removed");
                    }
                } catch { report("error", "Cannot read or update settings. Check the configuration syntax, CLI and file permissions."); }
                if(apply) this.save(state);
            }
            if(apply && !bundle && !connection.entry && Object.keys(connection.applied).length === 0) delete state.connections[name];
        }
        if(apply) this.save(state);
        return results;
    }

    candidates(kind?: McpKind, clients = this.read().clients): { entries: ImportCandidate[]; errors: string[] } {
        const entries: ImportCandidate[] = [];
        const errors: string[] = [];
        for(const client of clients) {
            const target = this.targets.find((item) => item.id === client);
            try {
                if(!target) throw new RegistryError();
                for(const [name, entry] of Object.entries(target.readEntries())) {
                    const found = entryKind(entry);
                    if(found && !catalogLaunch(entry) && (!kind || found === kind)) entries.push({ client, name, kind: found, entry });
                }
            } catch { errors.push(`${CLIENT_LABELS[client]}: cannot inspect existing entries.`); }
        }
        return { entries, errors };
    }

    importEntry(name: string, chosen: ImportCandidate, reviewed: ImportCandidate[]): SyncResult[] {
        this.validateName(chosen.kind, name);
        if(catalogLaunch(chosen.entry)) throw new RegistryError("Session server entries are not individual connections.");
        return this.change((state) => {
            if(!name.trim()) throw new RegistryError("A connection name is required.");
            const previous = own(state.connections, name) ? state.connections[name] : undefined;
            if(name !== chosen.name && previous) throw new RegistryError("That shared name already exists. Choose a new name to keep both connections.");
            if(previous && previous.kind !== chosen.kind) throw new RegistryError("This name belongs to another MCP. Choose another name.");
            const applied = { ...previous?.applied };
            for(const candidate of reviewed) {
                const target = this.targets.find((item) => item.id === candidate.client);
                const actual = target?.readEntries()[candidate.name];
                if(!actual || entryHash(actual) !== entryHash(candidate.entry)) throw new RegistryError("Settings changed since review; import again.");
                if(candidate.name === name && candidate.kind === chosen.kind) applied[candidate.client] = entryHash(actual);
            }
            Object.defineProperty(state.connections, name, { value: { kind: chosen.kind, entry: chosen.entry, applied }, enumerable: true, configurable: true, writable: true });
        });
    }

    resolve(client: ClientId, name: string, expected: McpServerEntry, useClient: boolean): SyncResult[] {
        return this.change((state) => {
            const sessionKind = KINDS.find(kind => sessionName(kind) === name && state.sessions?.[kind]);
            if(sessionKind) {
                const actual = this.targets.find(item => item.id === client)?.readEntries()[name];
                if(!actual || entryHash(actual) !== entryHash(expected)) throw new RegistryError("Settings changed since review; run Sync again.");
                if(useClient || entryKind(actual) !== sessionKind) throw new RegistryError("Session launches can only be restored from AKMS. Keep external settings or rename the conflicting entry manually.");
                state.sessions![sessionKind]!.applied[client] = entryHash(actual);
                return;
            }
            const connection = own(state.connections, name) ? state.connections[name] : undefined;
            const target = this.targets.find((item) => item.id === client);
            const actual = target?.readEntries()[name];
            if(!connection || !actual || entryHash(actual) !== entryHash(expected)) throw new RegistryError("Settings changed since review; run Sync again.");
            if(entryKind(actual) !== connection.kind) throw new RegistryError("This entry runs a different server. Rename it manually before retrying.");
            connection.applied[client] = entryHash(actual);
            if(useClient) {
                if(!state.clients.includes(client)) throw new RegistryError("Register this service before importing its changes.");
                this.validateName(connection.kind, name);
                if(catalogLaunch(actual)) throw new RegistryError("A session server cannot be imported as an individual connection.");
                connection.entry = actual;
                delete connection.replacement;
            }
        });
    }

    target(kind: McpKind): ConfigTarget {
        const registry = this;
        let snapshot: Record<string, McpServerEntry> | undefined;
        const expected = (name: string) => snapshot ? (own(snapshot, name) ? entryHash(snapshot[name]) : null) : undefined;
        const saved = (results: SyncResult[]): ConfigWriteResult => ({ status: "written", detail: formatResults(results, "Saved in the shared AKMS catalog.") });
        const prepare = (name: string, entry: McpServerEntry, oldName?: string): McpServerEntry => {
            if(!registry.read().clients.length) throw new RegistryError("Register at least one AI service before saving a connection.");
            const prior = snapshot && own(snapshot, oldName ?? name) ? snapshot[oldName ?? name] : undefined;
            if(prior && !standardLaunch(prior, kind)) return { ...entry, command: prior.command, args: [...prior.args] };
            const runtime = registry.requireRuntime(kind);
            return { ...entry, command: runtime.command, args: [...runtime.args] };
        };
        return {
            id: "registered", detected: true,
            get label() { const clients = registry.read().clients; return clients.length ? clients.map((id) => CLIENT_LABELS[id]).join(" · ") : "No services registered"; },
            location: this.file,
            readEntries: () => {
                const entries = Object.fromEntries(Object.entries(registry.read().connections).filter(([, value]) => value.kind === kind && value.entry).map(([name, value]) => [name, value.entry!]));
                snapshot = structuredClone(entries);
                return entries;
            },
            hasEntry: (name) => own(registry.read().connections, name),
            prepareEntry: prepare,
            writeEntry: (name, entry) => saved(registry.write(kind, name, prepare(name, entry), undefined, expected(name))),
            renameEntry: (oldName, name, entry) => saved(registry.write(kind, name, prepare(name, entry, oldName), oldName, expected(oldName))),
            removeEntry: (name) => saved(registry.remove(kind, name, expected(name))),
        };
    }
}

export function formatResults(results: SyncResult[], prefix = ""): string {
    const lines = prefix ? [prefix] : [];
    if(!results.length) return [...lines, "  No shared connections need applying."].join("\n");
    const attention = results.filter((item) => !["synced", "removed"].includes(item.status));
    const total = new Set(results.map((item) => item.name)).size;
    const unresolved = new Set(attention.map((item) => item.name)).size;
    lines.push(`  Connections: ${total - unresolved} complete · ${unresolved} need attention`);
    const updated = results.filter((item) => item.status === "synced" && item.detail === "Applied").length;
    const unchanged = results.filter((item) => item.status === "synced" && item.detail !== "Applied").length;
    const removed = results.filter((item) => item.status === "removed").length;
    lines.push(`  Service entries: ${updated} updated · ${unchanged} already up to date${removed ? ` · ${removed} removed` : ""}`);
    for(const [heading, rows] of [
        ["Needs review (existing settings kept)", attention.filter((item) => item.status === "conflict")],
        ["Could not finish", attention.filter((item) => item.status !== "conflict")],
    ] as const) {
        if(!rows.length) continue;
        lines.push(`\n${heading}:`);
        for(const name of new Set(rows.map((item) => item.name))) {
            lines.push(`  ${name.replace(/[\x00-\x1f\x7f]/g, " ")}`);
            for(const row of rows.filter((item) => item.name === name)) lines.push(`    ${CLIENT_LABELS[row.client]}: ${row.detail}`);
        }
    }
    if(attention.length) lines.push("\nNext: open Sync to compare settings or retry unfinished changes.");
    return lines.join("\n");
}
