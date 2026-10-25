import type { Readable, Writable } from "node:stream";

/**
 * Input ended before a prompt was answered — Ctrl+D, Ctrl+C, or a piped script running out.
 * The `config` loop treats it as leaving, not as a failure.
 */
export class PromptClosedError extends Error {
    constructor() {
        super("input closed before the prompt was answered");
        this.name = "PromptClosedError";
    }
}

/**
 * The user pressed Esc: leave this prompt without answering and go back one level. Every
 * prompt throws it, so a caller that opened a sub-screen (a field editor, a confirmation)
 * returns to where it was with nothing changed. Off a TTY a line of just `ESC` means the same.
 */
export class PromptBackError extends Error {
    constructor() {
        super("prompt left with esc");
        this.name = "PromptBackError";
    }
}

export interface SelectChoice<T extends string> {
    value: T;
    label: string;
    /** Dimmed text after the label. */
    hint?: string;
    /** What a line-mode answer may type besides the number and the label; defaults to `value`. */
    key?: string;
}

/** A non-selectable divider between groups of choices. */
export interface SelectSeparator {
    separator: true;
}

export type SelectItem<T extends string> = SelectChoice<T> | SelectSeparator;

export interface SelectOptions<T extends string> {
    /** Where the cursor starts, and what Enter picks on an empty line-mode answer. */
    defaultValue?: T;
    /** Returned on Esc instead of throwing `PromptBackError` — for a menu that has a "back" row of its own. */
    cancelValue?: T;
}

/** The subset of `tty.ReadStream` the key-driven prompts need; absent on pipes and in tests. */
interface TtyInput {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
}

/** The subset of `tty.WriteStream` the renderer reads. */
interface TtyOutput {
    isTTY?: boolean;
    columns?: number;
}

const ESC = "\u001b";
const KEY_UP = [`${ESC}[A`, `${ESC}OA`];
const KEY_DOWN = [`${ESC}[B`, `${ESC}OB`];
const KEY_RIGHT = [`${ESC}[C`, `${ESC}OC`];
const KEY_LEFT = [`${ESC}[D`, `${ESC}OD`];
const KEY_HOME = [`${ESC}[H`, `${ESC}OH`, `${ESC}[1~`, "\u0001"];
const KEY_END = [`${ESC}[F`, `${ESC}OF`, `${ESC}[4~`, "\u0005"];
const KEY_DELETE = [`${ESC}[3~`];
const KEY_ENTER = ["\r", "\n"];
const KEY_BACKSPACE = ["\u007f", "\b"];
const KEY_CTRL_C = "\u0003";
const KEY_CTRL_D = "\u0004";
/** Ctrl+U — clear the line, as in every shell. */
const KEY_CLEAR_LINE = "\u0015";

/** Splits a raw-mode chunk into keys: one character, or one whole escape sequence. */
function splitKeys(chunk: string): string[] {
    const keys: string[] = [];
    let index = 0;

    while (index < chunk.length) {
        const isSequence = chunk[index] === ESC && (chunk[index + 1] === "[" || chunk[index + 1] === "O");
        if (isSequence == true) {
            let end = index + 2;
            while (end < chunk.length && /[0-9;]/.test(chunk[end]) == true) {
                end += 1;
            }
            keys.push(chunk.slice(index, end + 1));
            index = end + 1;
            continue;
        }

        const codePoint = chunk.codePointAt(index) ?? 0;
        const character = String.fromCodePoint(codePoint);
        keys.push(character);
        index += character.length;
    }

    return keys;
}

/** True for a key that is text to insert, not a control character or an escape sequence. */
function isPrintableKey(key: string): boolean {
    if (key.startsWith(ESC) == true) {
        return false;
    }

    const codePoint = key.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f;
}

/** Terminal columns a code point occupies — two for CJK, Hangul and the wide emoji blocks. */
function charWidth(codePoint: number): number {
    if (codePoint < 0x1100) {
        return 1;
    }

    const isWide = codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
        || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd);

    if (isWide == true) {
        return 2;
    }

    return 1;
}

export function displayWidth(text: string): number {
    let width = 0;
    for (const character of text) {
        width += charWidth(character.codePointAt(0) ?? 0);
    }

    return width;
}

/** Pads with spaces to `width` terminal columns, counting wide characters as two. */
function padToWidth(text: string, width: number): string {
    const missing = width - displayWidth(text);
    if (missing <= 0) {
        return text;
    }

    return `${text}${" ".repeat(missing)}`;
}

/**
 * Label column width per item, measured within its group — the run of choices between
 * separators. One width for the whole list would push the hints of short action labels
 * ("Quit") out to wherever the longest host row ends.
 */
function groupLabelWidths<T extends string>(items: SelectItem<T>[]): number[] {
    const widths = items.map(() => 0);
    let groupStart = 0;

    for (let index = 0; index <= items.length; index += 1) {
        const atBoundary = index === items.length || "value" in items[index] == false;
        if (atBoundary == false) {
            continue;
        }

        let groupWidth = 0;
        for (let member = groupStart; member < index; member += 1) {
            const item = items[member] as SelectChoice<T>;
            groupWidth = Math.max(groupWidth, displayWidth(item.label));
        }
        for (let member = groupStart; member < index; member += 1) {
            widths[member] = groupWidth;
        }

        groupStart = index + 1;
    }

    return widths;
}

/**
 * Legacy Windows consoles render `❯` / `✔` as boxes; Windows Terminal, the VS Code
 * terminal and every non-Windows terminal draw them. Same rule inquirer's `figures` uses.
 */
export function supportsUnicode(): boolean {
    if (process.platform !== "win32") {
        return true;
    }

    return process.env.WT_SESSION != null
        || process.env.TERM_PROGRAM === "vscode"
        || process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
        || process.env.ConEmuTask != null;
}

interface Style {
    accent(text: string): string;
    success(text: string): string;
    warning(text: string): string;
    error(text: string): string;
    dim(text: string): string;
    bold(text: string): string;
}

function createStyle(enabled: boolean): Style {
    const paint = (open: number, close: number) => {
        return (text: string): string => {
            if (enabled == false || text === "") {
                return text;
            }
            return `${ESC}[${open}m${text}${ESC}[${close}m`;
        };
    };

    return {
        accent: paint(36, 39),
        success: paint(32, 39),
        warning: paint(33, 39),
        error: paint(31, 39),
        dim: paint(2, 22),
        bold: paint(1, 22),
    };
}

/** One piece of a rendered line: plain text and the style it is drawn with. */
interface LinePart {
    text: string;
    paint?: (text: string) => string;
}

/** What a raw-mode text read reports back. */
type LineReadResult = { kind: "entered"; text: string } | { kind: "back" };

/**
 * Prompts over any stream pair, with one `data` listener owning the input.
 *
 * On a TTY every prompt runs in raw mode — a select is an arrow-key list, a text field is a
 * small line editor — so Esc is seen everywhere and means "back one level"
 * (`PromptBackError`). Each answered prompt collapses to a single `✔ question · answer`
 * line, so the transcript reads as a summary of what was set. Off a TTY — a pipe, a test,
 * Git Bash's mintty without winpty — every prompt is a plain line read, a list is numbered,
 * and a line of just `ESC` stands for the Esc key; that is what lets the whole UI run over
 * scripted stdin.
 *
 * One listener instead of `readline`: raw-mode keys and cooked-mode lines would otherwise be
 * seen by two consumers at once — and a cooked-mode read never sees Esc at all, the terminal
 * either eats it or hands it over as a character inside the value.
 */
export class Prompter {
    private lineBuffer = "";
    private readonly pendingLines: string[] = [];
    private lineWaiter: ((line: string | null) => void) | null = null;
    private inputEnded = false;

    /** Set while a key-driven prompt owns the input. */
    private keyHandler: ((key: string) => void) | null = null;

    /**
     * When true, an answered prompt leaves nothing behind on a TTY instead of its
     * `✔ question · answer` line. The settings form sets it: the form itself shows every
     * value, so it can redraw in place rather than scroll a trail of edits.
     */
    transient = false;

    private readonly interactive: boolean;
    private readonly style: Style;
    private readonly symbols: { question: string; pointer: string; tick: string; rule: string };

    constructor(private readonly input: Readable, private readonly output: Writable) {
        const ttyInput = input as TtyInput;
        const ttyOutput = output as TtyOutput;
        this.interactive = ttyInput.isTTY == true && ttyInput.setRawMode != null && ttyOutput.isTTY == true;
        this.style = createStyle(this.interactive == true && process.env.NO_COLOR == null);

        if (supportsUnicode() == true) {
            this.symbols = { question: "?", pointer: "❯", tick: "✔", rule: "─" };
        }
        else {
            this.symbols = { question: "?", pointer: ">", tick: "√", rule: "-" };
        }

        input.setEncoding("utf8");
        input.on("data", (chunk: string) => {
            this.onData(chunk);
        });
        input.on("end", () => {
            this.inputEnded = true;
            if (this.lineWaiter != null) {
                const waiter = this.lineWaiter;
                this.lineWaiter = null;
                waiter(null);
            }
            if (this.keyHandler != null) {
                this.keyHandler(KEY_CTRL_D);
            }
        });
    }

    /** Stops reading so the process can exit once the command is done. */
    close(): void {
        if (this.interactive == true) {
            (this.input as TtyInput).setRawMode?.(false);
            this.output.write(`${ESC}[?25h`);
        }
        this.input.pause();
    }

    /** Available content columns, leaving room for the terminal cursor. */
    get width(): number { return this.columns() - 1; }

    /** Start a fresh terminal page without erasing scrollback or emitting ANSI to pipes. */
    clearScreen(): void {
        if(this.interactive) this.output.write(`${ESC}[2J${ESC}[H`);
    }

    /** Keep results visible before navigating; Esc acknowledges them like Enter. */
    async acknowledge(): Promise<void> {
        try { await this.pause(); }
        catch(error) { if(!(error instanceof PromptBackError)) throw error; }
    }

    write(text: string): void {
        this.output.write(text);
    }

    /** Styling for callers that print around the prompts; plain text off a TTY. */
    get paint(): Style {
        return this.style;
    }

    /** Keeps a report visible until Enter on a TTY; Esc goes back. Pipes need no extra answer. */
    async pause(): Promise<void> {
        if (this.interactive == false) {
            return;
        }
        if (this.inputEnded == true) {
            throw new PromptClosedError();
        }

        const prompt = this.fitLine([{ text: "Press Enter to continue", paint: this.style.dim }], this.columns() - 1);
        await this.readText(prompt, false);
    }

    /**
     * Free-text prompt. Enter accepts `defaultValue` when one is shown.
     *
     * @throws {PromptBackError} On Esc.
     * @throws {PromptClosedError} If the input closes before a line arrives.
     */
    async ask(question: string, defaultValue?: string): Promise<string> {
        let suffix = "";
        if (defaultValue != null && defaultValue !== "") {
            suffix = ` ${this.style.dim(`(${defaultValue})`)}`;
        }

        const prompt = `${this.style.accent(this.symbols.question)} ${this.style.bold(question)}${suffix} `;
        const typed = await this.readText(prompt, false);

        let answer = typed.trim();
        if (answer === "" && defaultValue != null) {
            answer = defaultValue;
        }

        let shown = answer;
        if (shown === "") {
            shown = this.style.dim("(empty)");
        }
        this.writeAnswered(question, shown);
        return answer;
    }

    /** Like `ask`, re-asking until something non-empty is entered. */
    async askRequired(question: string, defaultValue?: string): Promise<string> {
        for (;;) {
            const answer = await this.ask(question, defaultValue);
            if (answer !== "") {
                return answer;
            }

            this.output.write(`  ${this.style.dim("A value is required.")}\n`);
        }
    }

    /**
     * @throws {PromptBackError} On Esc — the caller decides what "neither" means.
     * @throws {PromptClosedError} If the input closes before a line arrives.
     */
    async askYesNo(question: string, defaultValue: boolean): Promise<boolean> {
        let hint = "y/N";
        if (defaultValue == true) {
            hint = "Y/n";
        }

        for (;;) {
            const prompt = `${this.style.accent(this.symbols.question)} ${this.style.bold(question)} ${this.style.dim(`(${hint})`)} `;
            const typed = await this.readText(prompt, false);

            const normalized = typed.trim().toLowerCase();
            let answer: boolean | null = null;
            if (normalized === "") {
                answer = defaultValue;
            }
            else if (normalized === "y" || normalized === "yes") {
                answer = true;
            }
            else if (normalized === "n" || normalized === "no") {
                answer = false;
            }

            if (answer != null) {
                let shown = "no";
                if (answer == true) {
                    shown = "yes";
                }
                this.writeAnswered(question, shown);
                return answer;
            }

            this.output.write(`  ${this.style.dim("Answer y or n.")}\n`);
        }
    }

    /**
     * Picks one of `items`. On a TTY: ↑/↓ move, 1–9 jump, Enter picks, Esc goes back. Off a
     * TTY: a numbered list, answered by number, key or label.
     *
     * @throws {PromptBackError} On Esc without a `cancelValue`.
     * @throws {PromptClosedError} On Ctrl+C or when the input closes.
     */
    async select<T extends string>(question: string, items: SelectItem<T>[], options?: SelectOptions<T>): Promise<T> {
        const choices = items.filter((item): item is SelectChoice<T> => "value" in item);
        if (choices.length === 0) {
            throw new Error("select needs at least one choice");
        }

        let startIndex = items.findIndex((item) => "value" in item && item.value === options?.defaultValue);
        if (startIndex < 0) {
            startIndex = items.findIndex((item) => "value" in item);
        }

        let picked: T | null;
        if (this.interactive == true) {
            picked = await this.selectWithKeys(question, items, startIndex);
        }
        else {
            picked = await this.selectWithLines(question, items, startIndex);
        }

        if (picked != null) {
            return picked;
        }

        if (options?.cancelValue != null) {
            return options.cancelValue;
        }

        throw new PromptBackError();
    }

    /**
     * Reads a value without echoing it on a TTY. Empty means "none", or "keep" when the
     * caller says a value already exists.
     *
     * @throws {PromptBackError} On Esc.
     * @throws {PromptClosedError} On Ctrl+C or when the input closes.
     */
    async askSecret(question: string): Promise<string> {
        const prompt = `${this.style.accent(this.symbols.question)} ${this.style.bold(question)} `;
        const secret = await this.readText(prompt, true);

        let shown = this.style.dim("(empty)");
        if (secret !== "") {
            shown = "•".repeat(Math.min(secret.length, 8));
        }
        this.writeAnswered(question, shown);
        return secret;
    }

    // ── input ──────────────────────────────────────────────────────────────

    /**
     * One text answer, through the line editor on a TTY and a line read off one. The prompt
     * is erased once answered; the caller writes the summary line.
     *
     * @throws {PromptBackError} On Esc, or a line of just `ESC` off a TTY.
     */
    private async readText(prompt: string, secret: boolean): Promise<string> {
        if (this.interactive == false) {
            this.output.write(prompt);
            const line = await this.readLine();
            if (line == null) {
                throw new PromptClosedError();
            }
            if (line === ESC) {
                throw new PromptBackError();
            }
            return line;
        }

        const result = await this.editLine(prompt, secret);
        if (result.kind === "back") {
            throw new PromptBackError();
        }

        return result.text;
    }

    private readLine(): Promise<string | null> {
        const queued = this.pendingLines.shift();
        if (queued != null) {
            return Promise.resolve(queued);
        }

        if (this.inputEnded == true) {
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            this.lineWaiter = resolve;
        });
    }

    private onData(chunk: string): void {
        if (this.keyHandler != null) {
            for (const key of splitKeys(chunk)) {
                // A key that finishes the prompt hands the rest of the chunk to whatever
                // reads next; there is no next reader yet, so it is dropped, as a TTY would.
                if (this.keyHandler == null) {
                    break;
                }
                this.keyHandler(key);
            }
            return;
        }

        this.lineBuffer += chunk;

        let newlineIndex = this.lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

            if (this.lineWaiter != null) {
                const waiter = this.lineWaiter;
                this.lineWaiter = null;
                waiter(line);
            }
            else {
                this.pendingLines.push(line);
            }

            newlineIndex = this.lineBuffer.indexOf("\n");
        }
    }

    /**
     * A one-line editor in raw mode: insert at the cursor, Backspace / Delete, ←/→, Home /
     * End, Ctrl+U clears, Enter answers, Esc goes back. Secrets draw nothing after the
     * prompt. Cooked mode is not used for text on a TTY because it never reports Esc: the
     * terminal swallows it or stuffs the `ESC` byte into the value.
     */
    private editLine(prompt: string, secret: boolean): Promise<LineReadResult> {
        const ttyInput = this.input as TtyInput;
        const plainPrompt = prompt.replace(/\u001b\[[0-9;]*m/g, "");

        let characters: string[] = [];
        let cursor = 0;

        const draw = (): void => {
            let text = `\r${ESC}[2K${prompt}`;
            if (secret == false) {
                text += characters.join("");
                const column = displayWidth(plainPrompt) + displayWidth(characters.slice(0, cursor).join(""));
                text += `\r${ESC}[${column}C`;
            }
            this.output.write(text);
        };

        return new Promise<LineReadResult>((resolve, reject) => {
            const finish = (): void => {
                this.keyHandler = null;
                ttyInput.setRawMode?.(false);
                this.output.write(`\r${ESC}[2K`);
            };

            this.keyHandler = (key: string) => {
                if (key === KEY_CTRL_C || key === KEY_CTRL_D) {
                    finish();
                    reject(new PromptClosedError());
                    return;
                }

                if (KEY_ENTER.includes(key) == true) {
                    finish();
                    resolve({ kind: "entered", text: characters.join("") });
                    return;
                }

                if (key === ESC) {
                    finish();
                    resolve({ kind: "back" });
                    return;
                }

                if (KEY_BACKSPACE.includes(key) == true) {
                    if (cursor > 0) {
                        characters.splice(cursor - 1, 1);
                        cursor -= 1;
                    }
                }
                else if (KEY_DELETE.includes(key) == true) {
                    characters.splice(cursor, 1);
                }
                else if (KEY_LEFT.includes(key) == true) {
                    cursor = Math.max(0, cursor - 1);
                }
                else if (KEY_RIGHT.includes(key) == true) {
                    cursor = Math.min(characters.length, cursor + 1);
                }
                else if (KEY_HOME.includes(key) == true) {
                    cursor = 0;
                }
                else if (KEY_END.includes(key) == true) {
                    cursor = characters.length;
                }
                else if (key === KEY_CLEAR_LINE) {
                    characters = [];
                    cursor = 0;
                }
                else if (isPrintableKey(key) == true) {
                    characters.splice(cursor, 0, key);
                    cursor += 1;
                }
                else {
                    return;
                }

                draw();
            };

            ttyInput.setRawMode?.(true);
            draw();
        });
    }

    private async selectWithLines<T extends string>(question: string, items: SelectItem<T>[], startIndex: number): Promise<T | null> {
        const choices = items.filter((item): item is SelectChoice<T> => "value" in item);
        const labelWidths = groupLabelWidths(items);

        this.output.write(`${this.symbols.question} ${question}\n`);

        let number = 0;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if ("value" in item == false) {
                this.output.write("\n");
                continue;
            }

            number += 1;
            let line = `  ${String(number).padStart(2)}) ${padToWidth(item.label, labelWidths[index])}`;
            if (item.hint != null && item.hint !== "") {
                line += `  ${item.hint}`;
            }
            this.output.write(`${line.trimEnd()}\n`);
        }

        const defaultChoice = items[startIndex] as SelectChoice<T>;
        const defaultNumber = choices.indexOf(defaultChoice) + 1;

        for (;;) {
            this.output.write(`Choice (${defaultNumber}): `);

            const line = await this.readLine();
            if (line == null) {
                throw new PromptClosedError();
            }

            if (line === ESC) {
                return null;
            }

            const answer = line.trim();
            if (answer === "") {
                return defaultChoice.value;
            }

            const index = Number(answer);
            if (Number.isInteger(index) == true && index >= 1 && index <= choices.length) {
                return choices[index - 1].value;
            }

            const lowered = answer.toLowerCase();
            const matched = choices.find((choice) => {
                const key = choice.key ?? choice.value;
                return key.toLowerCase() === lowered || choice.label.toLowerCase() === lowered;
            });
            if (matched != null) {
                return matched.value;
            }

            this.output.write(`  Pick a number from 1 to ${choices.length}.\n`);
        }
    }

    // ── TTY rendering ──────────────────────────────────────────────────────

    private columns(): number {
        const columns = (this.output as TtyOutput).columns;
        if (columns == null || columns < 20) {
            return 80;
        }

        return columns;
    }

    /** Joins styled parts, cutting the text (not the styles) once `width` columns are used. */
    private fitLine(parts: LinePart[], width: number): string {
        let used = 0;
        let line = "";

        for (const part of parts) {
            let text = "";
            for (const character of part.text) {
                const characterWidth = charWidth(character.codePointAt(0) ?? 0);
                if (used + characterWidth > width) {
                    break;
                }
                used += characterWidth;
                text += character;
            }

            if (part.paint != null) {
                line += part.paint(text);
            }
            else {
                line += text;
            }

            if (used >= width) {
                break;
            }
        }

        return line;
    }

    /** The one-line record an answered prompt leaves behind on a TTY. */
    private writeAnswered(question: string, answer: string): void {
        if (this.interactive == false || this.transient == true) {
            return;
        }

        this.output.write(`${this.style.success(this.symbols.tick)} ${question} ${this.style.dim("·")} ${this.style.accent(answer)}\n`);
    }

    /** @returns The picked value, or null on Esc. */
    private selectWithKeys<T extends string>(question: string, items: SelectItem<T>[], startIndex: number): Promise<T | null> {
        const ttyInput = this.input as TtyInput;
        const selectableIndexes = items.flatMap((item, index) => {
            if ("value" in item) {
                return [index];
            }
            return [];
        });
        const labelWidths = groupLabelWidths(items);
        const ruleWidth = Math.min(Math.max(...labelWidths), 24);

        let active = startIndex;
        let renderedLines = 0;

        const draw = (lines: string[]): void => {
            let text = "";
            if (renderedLines > 1) {
                text += `${ESC}[${renderedLines - 1}A`;
            }
            text += `\r${ESC}[J${lines.join("\n")}`;
            this.output.write(text);
            renderedLines = lines.length;
        };

        const buildLines = (): string[] => {
            const width = this.columns() - 1;
            const lines = [
                this.fitLine([
                    { text: this.symbols.question, paint: this.style.accent },
                    { text: " " },
                    { text: question, paint: this.style.bold },
                ], width),
            ];

            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                if ("value" in item == false) {
                    lines.push(this.fitLine([{ text: `  ${this.symbols.rule.repeat(ruleWidth)}`, paint: this.style.dim }], width));
                    continue;
                }

                const isActive = index === active;
                const parts: LinePart[] = [];
                if (isActive == true) {
                    parts.push({ text: `${this.symbols.pointer} `, paint: this.style.accent });
                    parts.push({ text: padToWidth(item.label, labelWidths[index]), paint: this.style.accent });
                }
                else {
                    parts.push({ text: "  " });
                    parts.push({ text: padToWidth(item.label, labelWidths[index]) });
                }

                if (item.hint != null && item.hint !== "") {
                    parts.push({ text: `  ${item.hint}`, paint: this.style.dim });
                }

                lines.push(this.fitLine(parts, width));
            }

            lines.push(this.fitLine([{ text: "↑↓ move · enter select · esc back", paint: this.style.dim }], width));

            return lines;
        };

        const move = (step: number): void => {
            const position = selectableIndexes.indexOf(active);
            const next = (position + step + selectableIndexes.length) % selectableIndexes.length;
            active = selectableIndexes[next];
        };

        return new Promise<T | null>((resolve, reject) => {
            const finish = (): void => {
                this.keyHandler = null;
                ttyInput.setRawMode?.(false);
                draw([]);
                this.output.write(`${ESC}[?25h`);
            };

            this.keyHandler = (key: string) => {
                if (key === KEY_CTRL_C || key === KEY_CTRL_D) {
                    finish();
                    reject(new PromptClosedError());
                    return;
                }

                if (KEY_ENTER.includes(key) == true) {
                    const picked = items[active] as SelectChoice<T>;
                    finish();
                    this.writeAnswered(question, picked.label);
                    resolve(picked.value);
                    return;
                }

                if (key === ESC) {
                    finish();
                    resolve(null);
                    return;
                }

                if (KEY_UP.includes(key) == true) {
                    move(-1);
                }
                else if (KEY_DOWN.includes(key) == true) {
                    move(1);
                }
                else if (KEY_HOME.includes(key) == true) {
                    active = selectableIndexes[0];
                }
                else if (KEY_END.includes(key) == true) {
                    active = selectableIndexes[selectableIndexes.length - 1];
                }
                else if (/^[1-9]$/.test(key) == true && Number(key) <= selectableIndexes.length) {
                    active = selectableIndexes[Number(key) - 1];
                }
                else {
                    return;
                }

                draw(buildLines());
            };

            ttyInput.setRawMode?.(true);
            this.output.write(`${ESC}[?25l`);
            draw(buildLines());
        });
    }
}
