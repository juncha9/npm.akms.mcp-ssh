import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PromptClosedError, Prompter } from "@/modules/manage/prompter";
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

    it("returns the cancel value on Esc, and ignores Esc when there is none", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const cancellable = prompter.select("Pick", [...ITEMS, { value: "back", label: "Back" }], { cancelValue: "back" });
        await press(terminal.input, ESC);
        expect(await cancellable).toBe("back");

        const required = prompter.select("Pick", ITEMS);
        await press(terminal.input, ESC, ENTER);
        expect(await required).toBe("alpha");
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
