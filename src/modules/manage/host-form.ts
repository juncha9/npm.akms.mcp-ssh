import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import { DEFAULT_SSH_PORT } from "@/_defs";
import { expandHomePath } from "@/_libs";
import type { HostAuthMethod, HostSetupAnswers } from "@/_types";

import { profileFromEnv, runConnectionCheck } from "./connection-check";
import { SERVER_NAME_PATTERN, answersToEntry } from "./entry";
import { PromptBackError } from "./prompter";
import type { Prompter, SelectChoice, SelectItem } from "./prompter";

/** Listed first when present, in this order — the keys `ssh` itself tries first. */
const PREFERRED_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** Files in `~/.ssh` that are never private keys, skipped without being opened. */
const NON_KEY_FILE_NAMES = ["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment"];

/** Larger than any private key; anything bigger is not opened. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

/** The answer that clears an optional value, since Enter keeps the one shown. */
const CLEAR_ANSWER = "-";

/** Select value for "type a path instead". Not a path a key could have. */
const OTHER_KEY_PATH = "\u0000other";

/** Column the values start at, past the longest setting name ("  Proxy command"). */
const FIELD_NAME_WIDTH = 17;

type HostRoute = "direct" | "jump" | "proxy" | "jump-proxy";

type FieldId =
    | "host" | "port" | "user" | "name"
    | "auth" | "key" | "passphrase" | "password"
    | "route" | "jump-host" | "jump-port" | "jump-user" | "proxy"
    | "description" | "readonly" | "paths"
    | "host-key" | "jump-host-key";

type FormAction = "test" | "save" | "cancel";

type FormValue = FieldId | FormAction;

/** Rows drawn under a parent setting; editing the parent moves the cursor past them. */
const SUB_FIELDS: FieldId[] = ["key", "passphrase", "password", "jump-host", "jump-port", "jump-user", "proxy"];

const FIELD_NAMES: Record<FieldId, string> = {
    "host": "Host",
    "port": "Port",
    "user": "User",
    "name": "Server name",
    "auth": "Authentication",
    "key": "Private key",
    "passphrase": "Passphrase",
    "password": "Password",
    "route": "Route",
    "jump-host": "Jump host",
    "jump-port": "Jump port",
    "jump-user": "Jump user",
    "proxy": "Proxy command",
    "description": "Description",
    "readonly": "Read-only",
    "paths": "File paths",
    "host-key": "Host key",
    "jump-host-key": "Jump host key",
};

const AUTH_LABELS: Record<HostAuthMethod, string> = {
    key: "Private key file",
    password: "Password",
    agent: "SSH agent",
};

const ROUTE_LABELS: Record<HostRoute, string> = {
    "direct": "Directly",
    "jump": "Through a jump host",
    "proxy": "Through a proxy command",
    "jump-proxy": "Proxy command, then a jump host",
};

/** Shown in place of a value the entry cannot do without. */
const REQUIRED_MARK = "(required)";

interface FoundKey {
    /** As written into the entry: `~/.ssh/<name>`, portable across machines. */
    path: string;
    /** Key type and comment from the matching `.pub`, when there is one. */
    hint: string;
}

/** The form's working copy. Settings of a route or auth not chosen are kept until saving. */
interface FormState {
    answers: HostSetupAnswers;
    route: HostRoute;
    /** False while the server name still follows the host. */
    nameTouched: boolean;
    lastTest: "never" | "ok" | "failed";
    /** The answers at the last successful test; Save offers a test when they differ. */
    testedSnapshot: string | null;
}

export interface HostFormOptions {
    /** The host being edited; absent when adding one. */
    existing?: HostSetupAnswers;
    /** Every server name already in the file, ours or not. */
    takenNames: string[];
    /** Where Save writes to, as shown to the user. */
    destination: string;
}

/**
 * Private keys in `~/.ssh`, recognized by their first bytes rather than their names —
 * a key called `work` or `bastion.pem` is as common as `id_ed25519`.
 */
function findPrivateKeys(): FoundKey[] {
    const sshDirectory = path.join(os.homedir(), ".ssh");

    let names: string[] = [];
    try {
        names = fs.readdirSync(sshDirectory);
    }
    catch {
        return [];
    }

    const keys: FoundKey[] = [];
    for (const name of names) {
        if (name.endsWith(".pub") == true || NON_KEY_FILE_NAMES.includes(name) == true) {
            continue;
        }

        const fullPath = path.join(sshDirectory, name);
        let head = "";
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() == false || stat.size > MAX_KEY_FILE_BYTES) {
                continue;
            }

            const descriptor = fs.openSync(fullPath, "r");
            const buffer = Buffer.alloc(64);
            const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
            fs.closeSync(descriptor);
            head = buffer.subarray(0, bytesRead).toString("utf8");
        }
        catch {
            continue;
        }

        const isPemKey = head.startsWith("-----BEGIN") == true && head.includes("PRIVATE KEY") == true;
        const isPuttyKey = head.startsWith("PuTTY-User-Key-File") == true;
        if (isPemKey == false && isPuttyKey == false) {
            continue;
        }

        let hint = "";
        try {
            const publicKey = fs.readFileSync(`${fullPath}.pub`, "utf8").trim().split(/\s+/);
            hint = publicKey[0].replace(/^ssh-/, "");
            if (publicKey.length > 2) {
                hint += ` · ${publicKey.slice(2).join(" ")}`;
            }
        }
        catch {
            // No .pub beside it — the key is still usable, there is just nothing to show.
        }

        keys.push({ path: `~/.ssh/${name}`, hint: hint });
    }

    const rank = (key: FoundKey): number => {
        const index = PREFERRED_KEY_NAMES.indexOf(path.basename(key.path));
        if (index < 0) {
            return PREFERRED_KEY_NAMES.length;
        }
        return index;
    };

    return keys.sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path));
}

async function askPort(prompter: Prompter, question: string, current: number): Promise<number> {
    for (;;) {
        const answer = await prompter.ask(question, String(current));
        const parsed = Number(answer);
        if (Number.isInteger(parsed) == true && parsed > 0 && parsed <= 65535) {
            return parsed;
        }

        prompter.write("  Enter a port number between 1 and 65535.\n");
    }
}

/** Optional free text: Enter keeps `current`, `-` clears it. */
async function askOptional(prompter: Prompter, question: string, current: string | undefined): Promise<string | undefined> {
    const answer = await prompter.ask(question, current);
    if (answer === "" || answer === CLEAR_ANSWER) {
        return undefined;
    }

    return answer;
}

/**
 * Secret with three outcomes: a new value, keep the existing one (Enter when one exists),
 * or none. Never echoes the secret back.
 */
async function askOptionalSecret(prompter: Prompter, question: string, current: string | undefined): Promise<string | undefined> {
    let suffix = "(empty for none)";
    if (current != null) {
        suffix = `(enter keeps current, ${CLEAR_ANSWER} clears)`;
    }

    const answer = await prompter.askSecret(`${question} ${prompter.paint.dim(suffix)}`);
    if (answer === CLEAR_ANSWER) {
        return undefined;
    }

    if (answer === "") {
        return current;
    }

    return answer;
}

/**
 * Key file: the private keys found in `~/.ssh` as a list, plus "another path". A typed
 * path that does not exist is flagged, since the server would only say so at startup.
 */
async function askKeyPath(prompter: Prompter, current: string | undefined): Promise<string> {
    const found = findPrivateKeys();

    let picked = OTHER_KEY_PATH;
    if (found.length > 0 || current != null) {
        const items: SelectItem<string>[] = [];
        if (current != null && found.some((key) => key.path === current) == false) {
            items.push({ value: current, label: current, hint: "current" });
        }
        for (const key of found) {
            items.push({ value: key.path, label: key.path, hint: key.hint });
        }
        items.push({ separator: true });
        items.push({ value: OTHER_KEY_PATH, key: "other", label: "Another path…" });

        picked = await prompter.select("Private key", items, { defaultValue: current ?? found[0]?.path });
    }

    if (picked !== OTHER_KEY_PATH) {
        return picked;
    }

    for (;;) {
        const typed = await prompter.askRequired("Private key path");
        if (fs.existsSync(expandHomePath(typed)) == true) {
            return typed;
        }

        prompter.write(`  ${expandHomePath(typed)} does not exist.\n`);
        const useAnyway = await prompter.askYesNo("Use this path anyway?", false);
        if (useAnyway == true) {
            return typed;
        }
    }
}

function routeUsesJump(route: HostRoute): boolean {
    return route === "jump" || route === "jump-proxy";
}

function routeUsesProxy(route: HostRoute): boolean {
    return route === "proxy" || route === "jump-proxy";
}

function deriveServerName(host: string): string {
    return `ssh-${host}`.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48);
}

/** The answers as they will be written: settings of a route or auth not chosen are dropped. */
function finalizeAnswers(state: FormState): HostSetupAnswers {
    const answers: HostSetupAnswers = { ...state.answers };

    if (routeUsesJump(state.route) == false) {
        answers.jumpHost = undefined;
        answers.jumpPort = undefined;
        answers.jumpUser = undefined;
        answers.jumpHostKeyFingerprint = undefined;
    }

    if (routeUsesProxy(state.route) == false) {
        answers.proxyCommand = undefined;
    }

    if (answers.auth !== "key") {
        answers.keyPath = undefined;
        answers.passphrase = undefined;
    }

    if (answers.auth !== "password") {
        answers.password = undefined;
    }

    return answers;
}

function snapshotOf(state: FormState): string {
    return JSON.stringify(finalizeAnswers(state));
}

/** A copy deep enough to restore from: the answers' arrays and records are copied, not shared. */
function cloneState(state: FormState): FormState {
    return {
        ...state,
        answers: {
            ...state.answers,
            allowedPaths: [...state.answers.allowedPaths],
            extraEnv: { ...state.answers.extraEnv },
        },
    };
}

/** Puts `state` back to `snapshot` in place — the loop holds `state` by reference. */
function restoreState(state: FormState, snapshot: FormState): void {
    const restored = cloneState(snapshot);
    state.answers = restored.answers;
    state.route = restored.route;
    state.nameTouched = restored.nameTouched;
    state.lastTest = restored.lastTest;
    state.testedSnapshot = restored.testedSnapshot;
}

/** Settings the entry cannot do without that are still empty, in display order. */
function missingFields(state: FormState): FieldId[] {
    const { answers } = state;
    const missing: FieldId[] = [];

    if (answers.host === "") {
        missing.push("host");
    }
    if (answers.username === "") {
        missing.push("user");
    }
    // An empty name only happens while the host is empty too — the name follows it — so
    // asking for "Host" already covers it.
    if (answers.auth === "key" && answers.keyPath == null) {
        missing.push("key");
    }
    if (answers.auth === "password" && answers.password == null) {
        missing.push("password");
    }
    if (routeUsesJump(state.route) == true && answers.jumpHost == null) {
        missing.push("jump-host");
    }
    if (routeUsesProxy(state.route) == true && answers.proxyCommand == null) {
        missing.push("proxy");
    }

    return missing;
}

function describePin(fingerprint: string | undefined): string {
    if (fingerprint == null) {
        return "not pinned";
    }

    return `pinned · ${fingerprint.slice(0, 19)}…`;
}

function valueOrRequired(value: string | undefined): string {
    if (value == null || value === "") {
        return REQUIRED_MARK;
    }

    return value;
}

function fieldRow(id: FieldId, value: string, hint?: string): SelectChoice<FormValue> {
    let name = FIELD_NAMES[id];
    if (SUB_FIELDS.includes(id) == true) {
        name = `  ${name}`;
    }

    return {
        value: id,
        key: id,
        label: `${name.padEnd(FIELD_NAME_WIDTH)}${value}`,
        hint: hint,
    };
}

/** The form: every setting with its current value, then the actions. */
function buildRows(state: FormState, destination: string): SelectItem<FormValue>[] {
    const { answers } = state;
    const rows: SelectItem<FormValue>[] = [];

    rows.push(fieldRow("host", valueOrRequired(answers.host)));
    rows.push(fieldRow("port", String(answers.port)));
    rows.push(fieldRow("user", valueOrRequired(answers.username)));

    let nameValue = answers.name;
    let nameHint = "what the agent sees";
    if (state.nameTouched == false) {
        nameHint = "follows the host until you change it";
    }
    if (nameValue === "") {
        nameValue = "ssh-<host>";
    }
    rows.push(fieldRow("name", nameValue, nameHint));

    rows.push(fieldRow("auth", AUTH_LABELS[answers.auth]));
    if (answers.auth === "key") {
        rows.push(fieldRow("key", valueOrRequired(answers.keyPath)));

        let passphrase = "none";
        if (answers.passphrase != null) {
            passphrase = "set";
        }
        rows.push(fieldRow("passphrase", passphrase));
    }
    if (answers.auth === "password") {
        let password = REQUIRED_MARK;
        if (answers.password != null) {
            password = "set";
        }
        rows.push(fieldRow("password", password, "stored in the config file as plain text"));
    }

    rows.push(fieldRow("route", ROUTE_LABELS[state.route]));
    if (routeUsesJump(state.route) == true) {
        rows.push(fieldRow("jump-host", valueOrRequired(answers.jumpHost)));
        rows.push(fieldRow("jump-port", String(answers.jumpPort ?? DEFAULT_SSH_PORT)));

        let jumpUser = answers.jumpUser;
        if (jumpUser == null || jumpUser === answers.username) {
            let loginUser = answers.username;
            if (loginUser === "") {
                loginUser = "…";
            }
            jumpUser = `same as login (${loginUser})`;
        }
        rows.push(fieldRow("jump-user", jumpUser));
    }
    if (routeUsesProxy(state.route) == true) {
        rows.push(fieldRow("proxy", valueOrRequired(answers.proxyCommand), "%h %p %r → first hop"));
    }

    rows.push(fieldRow("description", answers.description ?? "none", "shown to the agent"));

    let readonly = "no";
    if (answers.readonly == true) {
        readonly = "yes";
    }
    rows.push(fieldRow("readonly", readonly, "enter toggles"));

    let paths = "anywhere";
    if (answers.allowedPaths.length > 0) {
        paths = answers.allowedPaths.join(", ");
    }
    rows.push(fieldRow("paths", paths, "where the file tools may read and write"));

    rows.push(fieldRow("host-key", describePin(answers.hostKeyFingerprint)));
    if (routeUsesJump(state.route) == true) {
        rows.push(fieldRow("jump-host-key", describePin(answers.jumpHostKeyFingerprint)));
    }

    rows.push({ separator: true });

    let testHint = "not run yet";
    if (state.lastTest === "ok") {
        testHint = "last run: OK";
    }
    else if (state.lastTest === "failed") {
        testHint = "last run: failed";
    }
    rows.push({ value: "test", key: "test", label: "Test the connection", hint: testHint });
    rows.push({ value: "save", key: "save", label: "Save", hint: `to ${destination}` });
    rows.push({ value: "cancel", key: "cancel", label: "Cancel" });

    return rows;
}

/**
 * Where the cursor goes after a setting is edited: the next row, so pressing Enter down
 * the list fills the form top to bottom. A parent setting skips the rows under it — they
 * were just asked as follow-ups — and the last setting hands over to Save.
 */
function nextCursor(state: FormState, destination: string, edited: FieldId): FormValue {
    if (edited === "readonly") {
        return edited;
    }

    const values = buildRows(state, destination).flatMap((row) => {
        if ("value" in row) {
            return [row.value];
        }
        return [];
    });

    let index = values.indexOf(edited) + 1;
    if (SUB_FIELDS.includes(edited) == false) {
        while (index < values.length && SUB_FIELDS.includes(values[index] as FieldId) == true) {
            index += 1;
        }
    }

    const next = values[index];
    if (next == null || next === "test") {
        return "save";
    }

    return next;
}

/**
 * Connects with the form's current values. On success, offers to pin unpinned keys —
 * while the operator is at the terminal anyway, so pinning becomes the default instead of
 * a step nobody takes. A pinned key that changed is offered for re-pinning with No as the
 * default: it is also what an impersonated host looks like.
 *
 * @returns True when the connection succeeded.
 */
async function testConnection(prompter: Prompter, output: Writable, state: FormState): Promise<boolean> {
    const answers = finalizeAnswers(state);

    output.write("\n");
    const profile = profileFromEnv(output, answersToEntry(answers).env);
    if (profile == null) {
        output.write("\n");
        state.lastTest = "failed";
        await prompter.pause();
        return false;
    }

    const result = await runConnectionCheck(profile, output);
    output.write("\n");
    await prompter.pause();

    if (result.connected == true) {
        if (result.hostKeyFingerprint != null && state.answers.hostKeyFingerprint == null) {
            const pin = await prompter.askYesNo("Pin this host key? (a changed key then aborts the connection)", true);
            if (pin == true) {
                state.answers.hostKeyFingerprint = result.hostKeyFingerprint;
            }
        }

        if (result.jumpHostKeyFingerprint != null && routeUsesJump(state.route) == true && state.answers.jumpHostKeyFingerprint == null) {
            const pin = await prompter.askYesNo("Pin the jump host key too?", true);
            if (pin == true) {
                state.answers.jumpHostKeyFingerprint = result.jumpHostKeyFingerprint;
            }
        }

        state.lastTest = "ok";
        state.testedSnapshot = snapshotOf(state);
        return true;
    }

    const hostKeyChanged = result.hostKeyFingerprint != null
        && state.answers.hostKeyFingerprint != null
        && result.hostKeyFingerprint !== state.answers.hostKeyFingerprint;
    if (hostKeyChanged == true) {
        output.write("  The host presented a different key than the pinned one. Re-pin only if you know it was rebuilt.\n");
        const repin = await prompter.askYesNo(`Pin ${result.hostKeyFingerprint} instead?`, false);
        if (repin == true) {
            state.answers.hostKeyFingerprint = result.hostKeyFingerprint ?? undefined;
            output.write("  Pinned the new key — test again to confirm.\n");
        }
    }

    const jumpKeyChanged = result.jumpHostKeyFingerprint != null
        && state.answers.jumpHostKeyFingerprint != null
        && result.jumpHostKeyFingerprint !== state.answers.jumpHostKeyFingerprint;
    if (jumpKeyChanged == true) {
        output.write("  The jump host presented a different key than the pinned one. Re-pin only if you know it was rebuilt.\n");
        const repin = await prompter.askYesNo(`Pin ${result.jumpHostKeyFingerprint} instead?`, false);
        if (repin == true) {
            state.answers.jumpHostKeyFingerprint = result.jumpHostKeyFingerprint ?? undefined;
            output.write("  Pinned the new key — test again to confirm.\n");
        }
    }

    state.lastTest = "failed";
    return false;
}

/**
 * Edits one setting. A choice that brings new required settings with it (key auth, a jump
 * host route) asks for them right away, so the form is never left half-filled by a switch.
 */
async function editField(prompter: Prompter, output: Writable, state: FormState, id: FieldId): Promise<void> {
    const { answers } = state;

    if (id === "host") {
        let current: string | undefined;
        if (answers.host !== "") {
            current = answers.host;
        }
        answers.host = await prompter.askRequired("Host (hostname or IP)", current);
        if (state.nameTouched == false) {
            answers.name = deriveServerName(answers.host);
        }
        return;
    }

    if (id === "port") {
        answers.port = await askPort(prompter, "Port", answers.port);
        return;
    }

    if (id === "user") {
        let current: string | undefined;
        if (answers.username !== "") {
            current = answers.username;
        }
        answers.username = await prompter.askRequired("Login user", current);
        return;
    }

    if (id === "name") {
        let current: string | undefined;
        if (answers.name !== "") {
            current = answers.name;
        }
        for (;;) {
            const name = await prompter.askRequired("Server name the agent sees", current);
            if (SERVER_NAME_PATTERN.test(name) == true) {
                answers.name = name;
                state.nameTouched = true;
                return;
            }
            prompter.write("  Use letters, digits, '-' and '_' only (max 48) — the name becomes part of every tool name.\n");
        }
    }

    if (id === "auth") {
        answers.auth = await prompter.select<HostAuthMethod>(
            "Authentication",
            [
                { value: "key", label: AUTH_LABELS.key, hint: "only the path is stored — recommended" },
                { value: "password", label: AUTH_LABELS.password, hint: "stored in the config file as plain text" },
                { value: "agent", label: AUTH_LABELS.agent, hint: "keys already loaded in ssh-agent" },
            ],
            { defaultValue: answers.auth },
        );

        if (answers.auth === "key" && answers.keyPath == null) {
            answers.keyPath = await askKeyPath(prompter, undefined);
        }
        if (answers.auth === "password" && answers.password == null) {
            answers.password = await askOptionalSecret(prompter, "Password", undefined);
        }
        return;
    }

    if (id === "key") {
        answers.keyPath = await askKeyPath(prompter, answers.keyPath);
        return;
    }

    if (id === "passphrase") {
        answers.passphrase = await askOptionalSecret(prompter, "Key passphrase", answers.passphrase);
        return;
    }

    if (id === "password") {
        answers.password = await askOptionalSecret(prompter, "Password", answers.password);
        return;
    }

    if (id === "route") {
        state.route = await prompter.select<HostRoute>(
            "Route",
            [
                { value: "direct", label: ROUTE_LABELS.direct },
                { value: "jump", label: ROUTE_LABELS.jump, hint: "ssh -J" },
                { value: "proxy", label: ROUTE_LABELS.proxy, hint: "e.g. cloudflared access ssh" },
                { value: "jump-proxy", label: ROUTE_LABELS["jump-proxy"], hint: "cloudflared to the bastion, then on to the host" },
            ],
            { defaultValue: state.route },
        );

        if (routeUsesJump(state.route) == true && answers.jumpHost == null) {
            answers.jumpHost = await prompter.askRequired("Jump host");
        }
        if (routeUsesProxy(state.route) == true && answers.proxyCommand == null) {
            answers.proxyCommand = await prompter.askRequired("Proxy command", "cloudflared access ssh --hostname %h");
        }
        return;
    }

    if (id === "jump-host") {
        answers.jumpHost = await prompter.askRequired("Jump host", answers.jumpHost);
        return;
    }

    if (id === "jump-port") {
        answers.jumpPort = await askPort(prompter, "Jump host port", answers.jumpPort ?? DEFAULT_SSH_PORT);
        return;
    }

    if (id === "jump-user") {
        answers.jumpUser = await askOptional(prompter, "Jump host user (empty = same as the login user)", answers.jumpUser);
        return;
    }

    if (id === "proxy") {
        output.write(prompter.paint.dim("  %h / %p / %r expand to the first hop's host, port and user.\n"));
        answers.proxyCommand = await prompter.askRequired("Proxy command", answers.proxyCommand ?? "cloudflared access ssh --hostname %h");
        return;
    }

    if (id === "description") {
        answers.description = await askOptional(prompter, "Description shown to the agent", answers.description);
        return;
    }

    if (id === "readonly") {
        answers.readonly = answers.readonly == false;
        return;
    }

    if (id === "paths") {
        let current: string | undefined;
        if (answers.allowedPaths.length > 0) {
            current = answers.allowedPaths.join(",");
        }
        const typed = await askOptional(prompter, "Limit file tools to path prefixes (comma-separated, empty = anywhere)", current);
        answers.allowedPaths = [];
        if (typed != null) {
            answers.allowedPaths = typed.split(",").map((item) => item.trim()).filter((item) => item !== "");
        }
        return;
    }

    // host-key / jump-host-key: pinned → offer to unpin; unpinned → pinning happens in a test.
    const isJump = id === "jump-host-key";
    let pinned = answers.hostKeyFingerprint;
    if (isJump == true) {
        pinned = answers.jumpHostKeyFingerprint;
    }

    if (pinned != null) {
        const unpin = await prompter.askYesNo(`Unpin ${pinned}?`, false);
        if (unpin == true && isJump == true) {
            answers.jumpHostKeyFingerprint = undefined;
        }
        else if (unpin == true) {
            answers.hostKeyFingerprint = undefined;
        }
        return;
    }

    const missing = missingFields(state);
    if (missing.length > 0) {
        output.write(`  Fill in ${missing.map((field) => FIELD_NAMES[field]).join(", ")} first — the key is pinned by testing the connection.\n`);
        return;
    }

    await testConnection(prompter, output, state);
}

/**
 * The settings form for one host: every setting listed with its value, picked and edited
 * one at a time, in any order, as often as needed. Test and Save sit below the settings.
 *
 * Flow per pick:
 *  1) A setting — edit it, then move the cursor to the next one
 *  2) Test — connect with the current values; offer to pin the keys
 *  3) Save — require what is missing, settle a name clash, offer a test if the values
 *     changed since the last one, and hand the answers back
 *  4) Cancel / Esc — leave; a form with changes asks first
 *
 * On a TTY the form redraws in place: answered prompts leave no trail, since the form
 * itself shows every value.
 *
 * @returns The answers to write, or null when cancelled.
 */
export async function runHostForm(prompter: Prompter, output: Writable, options: HostFormOptions): Promise<HostSetupAnswers | null> {
    const { existing, takenNames, destination } = options;

    let state: FormState;
    if (existing != null) {
        let route: HostRoute = "direct";
        if (existing.jumpHost != null && existing.proxyCommand != null) {
            route = "jump-proxy";
        }
        else if (existing.jumpHost != null) {
            route = "jump";
        }
        else if (existing.proxyCommand != null) {
            route = "proxy";
        }

        state = { answers: { ...existing }, route: route, nameTouched: true, lastTest: "never", testedSnapshot: null };
    }
    else {
        const foundKeys = findPrivateKeys();
        state = {
            answers: {
                name: "",
                host: "",
                port: DEFAULT_SSH_PORT,
                username: "",
                auth: "key",
                keyPath: foundKeys[0]?.path,
                readonly: false,
                allowedPaths: [],
                extraEnv: {},
            },
            route: "direct",
            nameTouched: false,
            lastTest: "never",
            testedSnapshot: null,
        };
    }

    const initialSnapshot = snapshotOf(state);
    const originalName = existing?.name;

    let title = "New host";
    if (existing != null) {
        title = `Editing ${existing.name}`;
    }

    output.write(prompter.paint.dim(`\n  Pick a setting to change it. In a text field, Enter keeps the value shown and ${CLEAR_ANSWER} clears it.\n\n`));

    const previousTransient = prompter.transient;
    prompter.transient = true;

    try {
        let cursor: FormValue = "host";

        for (;;) {
            const picked = await prompter.select(title, buildRows(state, destination), { defaultValue: cursor, cancelValue: "cancel" });

            // Esc inside anything the pick opened — a field editor, a confirmation, a
            // follow-up question — comes back here as PromptBackError. The form is restored to
            // what it held before the pick, and the cursor stays on the row that was picked.
            const before = cloneState(state);

            try {
                // (4) Cancel
                if (picked === "cancel") {
                    if (snapshotOf(state) !== initialSnapshot) {
                        const discard = await prompter.askYesNo("Discard the changes?", false);
                        if (discard == false) {
                            continue;
                        }
                    }
                    return null;
                }

                const missing = missingFields(state);

                // (2) Test
                if (picked === "test") {
                    if (missing.length > 0) {
                        output.write(`  Fill in ${missing.map((field) => FIELD_NAMES[field]).join(", ")} first.\n`);
                        cursor = missing[0];
                        continue;
                    }

                    const connected = await testConnection(prompter, output, state);
                    cursor = "test";
                    if (connected == true) {
                        cursor = "save";
                    }
                    continue;
                }

                // (3) Save
                if (picked === "save") {
                    if (missing.length > 0) {
                        output.write(`  Fill in ${missing.map((field) => FIELD_NAMES[field]).join(", ")} first.\n`);
                        cursor = missing[0];
                        continue;
                    }

                    const name = state.answers.name;
                    if (name !== originalName && takenNames.includes(name) == true) {
                        const replace = await prompter.askYesNo(`"${name}" already exists in this file. Replace it?`, false);
                        if (replace == false) {
                            cursor = "name";
                            continue;
                        }
                    }

                    if (snapshotOf(state) !== state.testedSnapshot) {
                        const testFirst = await prompter.askYesNo("Test the connection before saving?", true);
                        if (testFirst == true) {
                            const connected = await testConnection(prompter, output, state);
                            if (connected == false) {
                                const next = await prompter.select(
                                    "The check failed. What now?",
                                    [
                                        { value: "back", key: "back", label: "Back to the settings" },
                                        { value: "save", key: "save", label: "Save anyway", hint: "the host may be unreachable from here" },
                                        { value: "discard", key: "discard", label: "Discard", hint: "nothing is written" },
                                    ],
                                    { defaultValue: "back", cancelValue: "back" },
                                );

                                if (next === "discard") {
                                    return null;
                                }

                                if (next === "back") {
                                    cursor = "test";
                                    continue;
                                }
                            }
                        }
                    }

                    return finalizeAnswers(state);
                }

                // (1) A setting
                await editField(prompter, output, state, picked);
                cursor = nextCursor(state, destination, picked);
            }
            catch (ex) {
                if (ex instanceof PromptBackError == false) {
                    throw ex;
                }

                restoreState(state, before);
                cursor = picked;
            }
        }
    }
    finally {
        prompter.transient = previousTransient;
    }
}
