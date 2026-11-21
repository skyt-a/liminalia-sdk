# Liminalia for VS Code

[日本語](https://github.com/skyt-a/liminalia-sdk/blob/main/packages/vscode/README.md) | **English**

A VS Code extension for writing [Liminalia](https://liminalia.skyta.dev/en/) scenario scripts (`.lim`). It brings the same syntax checks, completion, refactoring, and Play from Here workflow as Liminalia Studio into your editor. It also works in VS Code-compatible editors such as Cursor and VSCodium.

## Features

- **Syntax highlighting**: Highlights labels (`# name`), commands (`@name key=value`), comments (`//`), dialogue speakers (`Name "…"` / `名前「…」`), inline markup (`{r 漢字|かんじ}`, `{br}`, `{= expr}`, `{b …}`, `{@command …}`), choices, expressions, and script tests (`.limtest`).
- **Live syntax and project checks**: Runs the same checks as `lim check` as you type, checking unsaved contents for open files and reporting diagnostics directly in `liminalia.json`, `cast.json`, and translation files (`lang/<language>.json`).
- **Completion and hovers**:
  - Completes command names after `@` (including `@define` macros and plugin commands), parameter names and typed values (characters, sprite sets, variants, positions, asset files), jump targets, speaker names at the start of a line, inline markup after `{`, and variables and functions in expressions.
  - Hover over commands, parameters, functions, variables, items, or jump targets to view summaries, parameter tables, and definition details.
  - Applies JSON Schemas to `liminalia.json`, `cast.json`, and `lang/*.json` for key completion, descriptions, and unknown-key warnings.
- **Navigation**: Supports Go to Definition (`F12`), Find All References (`⇧F12`), Outline, Workspace Symbols (`⌘T`), and code folding.
- **Formatting, Quick Fix, and Rename**:
  - "Format Document" (`⇧⌥F`) formats command lines the same way as `lim fmt` without touching dialogue or narration text.
  - Quick Fix (`⌘.`) applies suggested fixes for diagnostics such as misspelled names.
  - Rename (`F2`) updates scenes (labels), script files, macros, variables, characters, speakers, and assets across scripts, `liminalia.json`, `cast.json`, translation keys, and `voice-lock.json`.
- **Script tests**: Lists `tests/*.limtest` in VS Code's Testing view and runs them per file or per test, highlighting mismatches inline.
- **Play from Here** (`⌘⌥P` / `Ctrl+Alt+P`): Opens the game in your browser starting from the state immediately before the cursor line, connecting to Liminalia Studio or `lim studio`.
- **Japanese and English UI**: Commands, diagnostics, completion entries, and hover docs follow VS Code's display language (Japanese or English).

## Example

```lim
# morning
@bg hill_morning.webp time=1s
@chara Akari smlie at=left
Akari "Good morning. You're up early today."
@choice
  - Go out together -> #walk
  - Stay in bed -> #morning
@end
```

If you misspell the variant `smile` as `smlie` in `@chara`, the extension underlines the line with an error and offers a Quick Fix suggesting `smile`. It also flags the missing `#walk` label before you even save.

## Getting started

1. Install the extension from the Marketplace / Open VSX or from a `.vsix` file.
2. Open a project folder containing `liminalia.json`, then open any `.lim` file.

Changes to project settings, `cast.json`, or plugins reload automatically. If the extension doesn't pick up a change, run **Liminalia: Restart Language Server** from the Command Palette.

### Settings

| Setting | Description |
|---|---|
| `liminalia.studioApp` | Path to the Liminalia Studio app used by Play from Here (leave empty to auto-detect in standard install locations) |
| `liminalia.lim` | Path to the `lim` executable or `lim.mjs` used by Play from Here and script tests (leave empty to use `@liminalia/cli` in the project's `node_modules`) |
| `liminalia.node` | Path to the Node.js executable used to load plugins or run `lim.mjs` (leave empty to use the Node.js bundled with VS Code) |

### Workspace trust (restricted mode)

In untrusted workspaces and for `.lim` files opened outside the workspace folders, the extension does not execute project plugin code or project-local `lim` binaries (checks run with built-in and standard commands only).

## Building from source

```sh
npm install
npm run -w @liminalia/vscode build
npm run -w @liminalia/vscode package
```

Install the generated `packages/vscode/liminalia-<version>.vsix` via "Extensions: Install from VSIX..." in the VS Code Command Palette.

## Documentation

- [VS Code extension overview](https://liminalia.skyta.dev/en/vscode/)
- [VS Code extension technical docs](https://liminalia.skyta.dev/en/docs/vscode/)
- [Liminalia website](https://liminalia.skyta.dev/en/)

## License

This extension is governed by the [Liminalia license and terms of use](https://liminalia.skyta.dev/en/license/). Being able to read the source does not make it open source.
