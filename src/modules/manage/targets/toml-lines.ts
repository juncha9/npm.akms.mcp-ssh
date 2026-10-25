/** Track strings and arrays while locating editable TOML statements, after syntax validation. */
export interface TomlLineState {
    quote: string | null;
    multiline: boolean;
    depth: number;
}

export function lineState(): TomlLineState {
    return { quote: null, multiline: false, depth: 0 };
}

export function scanTomlLine(line: string, state: TomlLineState): void {
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (state.quote != null) {
            if (character === "\\" && state.quote === '"') {
                index += 1;
            }
            else if (character === state.quote) {
                if (!state.multiline) {
                    state.quote = null;
                }
                else if (line.slice(index, index + 3) === state.quote.repeat(3)) {
                    // Four/five quotes end a multiline string with one/two literal quotes.
                    while (line[index + 1] === character) {
                        index += 1;
                    }
                    state.quote = null;
                    state.multiline = false;
                }
            }
            continue;
        }
        if (character === "#") {
            break;
        }
        if (character === '"' || character === "'") {
            state.quote = character;
            state.multiline = line.slice(index, index + 3) === character.repeat(3);
            if (state.multiline) {
                index += 2;
            }
        }
        else if (character === "[" || character === "{") {
            state.depth += 1;
        }
        else if (character === "]" || character === "}") {
            state.depth -= 1;
        }
    }
}
