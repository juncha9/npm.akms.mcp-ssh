import type { Readable, Writable } from "node:stream";

export interface PromptChoice<T extends string> {
    key: T;
    label: string;
}

/**
 * Input ended before a prompt was answered — Ctrl+D, or a piped script running out. The
 * `config` loop treats it as leaving, not as a failure.
 */
export class PromptClosedError extends Error {
    constructor() {
        super("input closed before the prompt was answered");
        this.name = "PromptClosedError";
    }
}

/** The subset of `tty.ReadStream` a secret prompt needs; absent on pipes and in tests. */
interface RawModeStream {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
}

/**
 * Line prompts over any stream pair, with one `data` listener owning the input.
 *
 * `readline` was the obvious choice and was dropped: masking a secret means switching the
 * TTY to raw mode while readline's own listener is still attached, and both then see the
 * keystrokes. One listener that is either collecting a line or collecting a secret has no
 * such overlap. Off a TTY (tests, pipes) every prompt is a plain line read, which is what
 * lets the wizard run over scripted stdin.
 */
export class Prompter {
    private lineBuffer = "";
    private readonly pendingLines: string[] = [];
    private waiter: ((line: string | null) => void) | null = null;
    private inputEnded = false;

    private secretMode = false;
    private secretBuffer = "";

    constructor(private readonly input: Readable, private readonly output: Writable) {
        input.setEncoding("utf8");
        input.on("data", (chunk: string) => {
            this.onData(chunk);
        });
        input.on("end", () => {
            this.inputEnded = true;
            if (this.waiter != null) {
                const waiter = this.waiter;
                this.waiter = null;
                waiter(null);
            }
        });
    }

    /** Stops reading so the process can exit once the command is done. */
    close(): void {
        this.input.pause();
    }

    write(text: string): void {
        this.output.write(text);
    }

    /**
     * Free-text prompt. Enter accepts `defaultValue` when one is shown.
     *
     * @throws {PromptClosedError} If the input closes before a line arrives.
     */
    async ask(question: string, defaultValue?: string): Promise<string> {
        let suffix = "";
        if (defaultValue != null && defaultValue !== "") {
            suffix = ` [${defaultValue}]`;
        }

        this.output.write(`${question}${suffix}: `);

        const line = await this.readLine();
        if (line == null) {
            throw new PromptClosedError();
        }

        const trimmed = line.trim();
        if (trimmed === "" && defaultValue != null) {
            return defaultValue;
        }

        return trimmed;
    }

    /** Like `ask`, re-asking until something non-empty is entered. */
    async askRequired(question: string, defaultValue?: string): Promise<string> {
        for (;;) {
            const answer = await this.ask(question, defaultValue);
            if (answer !== "") {
                return answer;
            }

            this.output.write("  A value is required.\n");
        }
    }

    async askYesNo(question: string, defaultValue: boolean): Promise<boolean> {
        let hint = "[y/N]";
        if (defaultValue == true) {
            hint = "[Y/n]";
        }

        for (;;) {
            this.output.write(`${question} ${hint}: `);

            const line = await this.readLine();
            if (line == null) {
                throw new PromptClosedError();
            }

            const normalized = line.trim().toLowerCase();
            if (normalized === "") {
                return defaultValue;
            }

            if (normalized === "y" || normalized === "yes") {
                return true;
            }

            if (normalized === "n" || normalized === "no") {
                return false;
            }

            this.output.write("  Answer y or n.\n");
        }
    }

    /** Lists the choices one per line and accepts a key, case-insensitively. */
    async askChoice<T extends string>(question: string, choices: PromptChoice<T>[], defaultKey?: T): Promise<T> {
        this.output.write(`${question}\n`);
        for (const choice of choices) {
            this.output.write(`  ${choice.key}) ${choice.label}\n`);
        }

        for (;;) {
            const answer = await this.ask("Choice", defaultKey);
            const matched = choices.find((choice) => choice.key.toLowerCase() === answer.toLowerCase());
            if (matched != null) {
                return matched.key;
            }

            this.output.write(`  Pick one of ${choices.map((choice) => choice.key).join(", ")}.\n`);
        }
    }

    /**
     * Reads a value without echoing it on a TTY. Empty means "none", or "keep" when the
     * caller says a value already exists.
     */
    async askSecret(question: string): Promise<string> {
        const rawModeStream = this.input as RawModeStream;
        if (rawModeStream.isTTY != true || rawModeStream.setRawMode == null) {
            const answer = await this.ask(question);
            return answer;
        }

        this.output.write(`${question}: `);

        this.secretBuffer = "";
        this.secretMode = true;
        rawModeStream.setRawMode(true);

        try {
            const line = await this.readLine();
            if (line == null) {
                throw new PromptClosedError();
            }

            return line;
        }
        finally {
            rawModeStream.setRawMode(false);
            this.secretMode = false;
            this.output.write("\n");
        }
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
            this.waiter = resolve;
        });
    }

    private deliver(line: string): void {
        if (this.waiter != null) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(line);
            return;
        }

        this.pendingLines.push(line);
    }

    private onData(chunk: string): void {
        if (this.secretMode == true) {
            // Raw mode: one chunk per keystroke, Enter arrives as "\r", no echo from the TTY.
            for (const character of chunk) {
                if (character === "\r" || character === "\n") {
                    const secret = this.secretBuffer;
                    this.secretBuffer = "";
                    this.deliver(secret);
                    continue;
                }

                if (character === "\u0003") {
                    this.output.write("\n");
                    process.exit(130);
                }

                if (character === "\u007f" || character === "\b") {
                    this.secretBuffer = this.secretBuffer.slice(0, -1);
                    continue;
                }

                this.secretBuffer += character;
            }
            return;
        }

        this.lineBuffer += chunk;

        let newlineIndex = this.lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
            this.deliver(line);
            newlineIndex = this.lineBuffer.indexOf("\n");
        }
    }
}
