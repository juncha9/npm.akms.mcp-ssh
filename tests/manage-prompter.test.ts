import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PromptBackError, PromptClosedError, Prompter } from "@/modules/manage/prompter";
import type { SelectItem } from "@/modules/manage/prompter";

const ESC = "\u001b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const CTRL_C = "\u0003";

type Value = "alpha" | "beta" | "gamma" | "back";

const ITEMS: SelectItem<Value>[] = [
    { value: "alpha", label: "Alpha" },
    { separator: true },
    { value: "beta", label: "Beta", hint: "the second" },
    { value: "gamma", label: "Gamma", key: "g" },
];

/** A stream pair that looks like a terminal: `isTTY`, raw mode, a width. */
function createTerminal(): { input: PassThrough; output: PassThrough; rawModes: boolean[]; screen: () => string } {
    const rawModes: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (mode: boolean) => {
            rawModes.push(mode);
        },
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });

    let written = "";
    output.on("data", (chunk: Buffer) => {
        written += chunk.toString();
    });

    return { input: input, output: output, rawModes: rawModes, screen: () => written };
}

/** Types keys one at a time, letting the prompt redraw between them as a person would. */
async function press(input: PassThrough, ...keys: string[]): Promise<void> {
    for (const key of keys) {
        input.write(key);
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("Prompter.select on a terminal", () => {
    it("moves with the arrow keys, skipping separators", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const picked = prompter.select("Pick", ITEMS);
        await press(terminal.input, DOWN, DOWN, ENTER);

        expect(await picked).toBe("gamma");
    });

    it("wraps around from the first choice to the last", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const picked = prompter.select("Pick", ITEMS);
        await press(terminal.input, UP, ENTER);

        expect(await picked).toBe("gamma");
    });

    it("starts on the default and jumps by number", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const onDefault = prompter.select("Pick", ITEMS, { defaultValue: "beta" });
        await press(terminal.input, ENTER);
        expect(await onDefault).toBe("beta");

        const byNumber = prompter.select("Pick", ITEMS);
        await press(terminal.input, "3", ENTER);
        expect(await byNumber).toBe("gamma");
    });

    it("returns the cancel value on Esc when the menu has a back row of its own", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const cancellable = prompter.select("Pick", [...ITEMS, { value: "back", label: "Back" }], { cancelValue: "back" });
        await press(terminal.input, ESC);

        expect(await cancellable).toBe("back");
    });

    it("leaves one summary line behind and hands the terminal back", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const picked = prompter.select("Authentication", ITEMS);
        await press(terminal.input, DOWN, ENTER);
        await picked;

        expect(stripAnsi(terminal.screen())).toMatch(/[✔√] Authentication · Beta\n$/);
        expect(terminal.rawModes).toEqual([true, false]);
        expect(terminal.screen()).toContain(`${ESC}[?25h`);
    });

    it("treats Ctrl+C as leaving and restores the terminal", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        // The rejection lands mid-`press`, so the expectation has to be listening first.
        const rejected = expect(prompter.select("Pick", ITEMS)).rejects.toBeInstanceOf(PromptClosedError);
        await press(terminal.input, CTRL_C);

        await rejected;
        expect(terminal.rawModes).toEqual([true, false]);
    });
});

describe("Prompter text prompts on a terminal", () => {
    it("collapses an answered question into a summary line", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const answer = prompter.ask("Host", "10.0.0.5");
        await press(terminal.input, "\n");

        expect(await answer).toBe("10.0.0.5");
        expect(stripAnsi(terminal.screen())).toMatch(/[✔√] Host · 10\.0\.0\.5\n$/);
    });

    it("never echoes a secret, and honours backspace", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const secret = prompter.askSecret("Password");
        await press(terminal.input, "h", "u", "n", "t", "e", "x", "\u007f", "r", "2", ENTER);

        expect(await secret).toBe("hunter2");
        expect(terminal.screen()).not.toContain("hunter");
        expect(terminal.rawModes).toEqual([true, false]);
    });
});

describe("Prompter.pause after a report", () => {
    it("keeps the next menu hidden until Enter and restores raw mode", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);
        prompter.write("Connection failed: the server refused the connection.\n");

        const next = (async () => {
            await prompter.pause();
            return prompter.select("Next menu", ITEMS);
        })();
        await press(terminal.input, DOWN);

        expect(stripAnsi(terminal.screen())).toContain("Press Enter to continue");
        expect(terminal.screen()).not.toContain("Next menu");
        expect(terminal.rawModes).toEqual([true]);

        await press(terminal.input, ENTER);
        expect(terminal.screen()).toContain("Next menu");
        await press(terminal.input, ENTER);
        expect(await next).toBe("alpha");
        expect(terminal.rawModes).toEqual([true, false, true, false]);
    });

    it("lets Esc go back and Ctrl+C cancel without continuing", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const back = expect(prompter.pause()).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, ESC);
        await back;

        const cancelled = expect(prompter.pause()).rejects.toBeInstanceOf(PromptClosedError);
        await press(terminal.input, CTRL_C);
        await cancelled;
        expect(terminal.rawModes).toEqual([true, false, true, false]);
    });

    it("handles input ending during and before a pause", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);
        const closed = expect(prompter.pause()).rejects.toBeInstanceOf(PromptClosedError);
        terminal.input.end();
        await closed;
        await expect(prompter.pause()).rejects.toBeInstanceOf(PromptClosedError);
        expect(terminal.rawModes).toEqual([true, false]);
    });

    it("does not consume a scripted answer or print a pause off a terminal", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let screen = "";
        output.on("data", (chunk: Buffer) => {
            screen += chunk.toString();
        });
        const prompter = new Prompter(input, output);
        input.end("beta\n");

        await prompter.pause();
        expect(screen).toBe("");
        expect(await prompter.select("Pick", ITEMS)).toBe("beta");
    });
});

describe("Prompter.select off a terminal", () => {
    it("numbers the choices and accepts a number, a key or a label", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let screen = "";
        output.on("data", (chunk: Buffer) => {
            screen += chunk.toString();
        });
        input.write("2\ng\nalpha\n\nnope\n1\n");

        const prompter = new Prompter(input, output);

        expect(await prompter.select("Pick", ITEMS)).toBe("beta");
        expect(await prompter.select("Pick", ITEMS)).toBe("gamma");
        expect(await prompter.select("Pick", ITEMS)).toBe("alpha");
        expect(await prompter.select("Pick", ITEMS, { defaultValue: "gamma" })).toBe("gamma");
        expect(await prompter.select("Pick", ITEMS)).toBe("alpha");

        expect(screen).toContain("   2) Beta   the second");
        expect(screen).toContain("Pick a number from 1 to 3.");
        expect(screen).not.toContain(ESC);
    });
});

describe("Esc means back, everywhere", () => {
    it("leaves a select without a cancel value as PromptBackError", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const rejected = expect(prompter.select("Pick", ITEMS)).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, ESC);

        await rejected;
        expect(terminal.rawModes).toEqual([true, false]);
    });

    it("leaves a text field without a value, and never stores the Esc byte", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const rejected = expect(prompter.ask("Host", "10.0.0.5")).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, "1", "0", ESC);
        await rejected;

        // The next prompt starts clean — nothing typed before the Esc leaks into it.
        const answer = prompter.ask("Host", "10.0.0.5");
        await press(terminal.input, ENTER);
        expect(await answer).toBe("10.0.0.5");
        expect(terminal.screen()).not.toContain(`${ESC}\n`);
    });

    it("leaves a secret as PromptBackError", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const rejected = expect(prompter.askSecret("Password")).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, "p", "w", ESC);

        await rejected;
        expect(terminal.rawModes).toEqual([true, false]);
    });

    it("leaves a yes/no as PromptBackError instead of guessing", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const rejected = expect(prompter.askYesNo("Remove?", false)).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, ESC);

        await rejected;
    });

    it("reads a line of just ESC as Esc off a terminal", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        input.write(`${ESC}\n${ESC}\n${ESC}\n`);

        const prompter = new Prompter(input, output);

        await expect(prompter.ask("Host")).rejects.toBeInstanceOf(PromptBackError);
        await expect(prompter.select("Pick", ITEMS)).rejects.toBeInstanceOf(PromptBackError);
        await expect(prompter.askYesNo("Sure?", true)).rejects.toBeInstanceOf(PromptBackError);
    });
});

describe("the line editor on a terminal", () => {
    it("inserts at the cursor, moves with the arrows, and deletes both ways", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);
        const LEFT = `${ESC}[D`;
        const RIGHT = `${ESC}[C`;
        const HOME = `${ESC}[H`;
        const DELETE = `${ESC}[3~`;
        const BACKSPACE = "\u007f";

        const answer = prompter.ask("Host");
        // "host" → cursor left twice → "hoXst" → home, delete → "oXst" → end-ish via right ×4 → backspace → "oXs"
        await press(terminal.input, "h", "o", "s", "t", LEFT, LEFT, "X", HOME, DELETE, RIGHT, RIGHT, RIGHT, RIGHT, BACKSPACE, ENTER);

        expect(await answer).toBe("oXs");
    });

    it("takes a pasted chunk as text, one character per key", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const answer = prompter.ask("Host");
        terminal.input.write("10.0.16.12\r");

        expect(await answer).toBe("10.0.16.12");
    });

    it("clears the line on Ctrl+U", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const answer = prompter.ask("Host", "fallback");
        await press(terminal.input, "a", "b", "\u0015", ENTER);

        expect(await answer).toBe("fallback");
    });
});
