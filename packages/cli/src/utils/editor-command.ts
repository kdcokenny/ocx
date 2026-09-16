import { ConfigError } from "./errors"

/** Parse editor arguments without executing shell substitutions or operators. */
export function editorCommand(command: string): string[] {
	if (Bun.which(command)) return [command]
	const args: string[] = []
	let word = ""
	let quote = ""
	let started = false
	for (let index = 0; index < command.length; index++) {
		const character = command[index] as string
		const next = command[index + 1]
		if (character === "\\" && quote !== "'" && next && /[\s"'\\]/.test(next)) {
			word += next
			index++
			started = true
		} else if (quote) {
			if (character === quote) quote = ""
			else word += character
		} else if (character === "'" || character === '"') {
			quote = character
			started = true
		} else if (/\s/.test(character)) {
			if (started) args.push(word)
			word = ""
			started = false
		} else {
			word += character
			started = true
		}
	}
	if (quote) throw new ConfigError("Unclosed quote in VISUAL/EDITOR")
	if (started) args.push(word)
	if (!args[0]) throw new ConfigError("VISUAL/EDITOR must name an executable")
	return args
}
