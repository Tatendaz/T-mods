# phone-check-nudge

After a turn that changed UI files and never looked at them, a band above the prompt says so and offers a Run check button.

You asked "Did you check the rest of the app on simulators?" and "make sure to test on the simulators that everything looks good and no issues" in past sessions. This catches the turn before you have to ask.

## What counts

- **A UI file**: `.tsx .jsx .vue .svelte .css .scss .sass .less .html .swift .kt`, or an Android `res/layout/*.xml`, edited with Edit, Write or NotebookEdit. Files under `tests/`, `e2e/`, `.claude/` or `node_modules/`, and `*.test.*`, `*.spec.*`, `*.stories.*` and `.d.ts` files are left out.
- **A look**: a Bash command with `xcrun simctl`, `idb`, `adb`, `maestro`, `playwright`, `screenshot`, `codeandconfirm`, `agent-browser` or `--headless`, or any Claude in Chrome, computer-use or Claude browser tool.

When a turn ends with UI edits and no look, the band appears: `UI changed, not checked on a phone (landing.tsx, hero.css)`. It stays until a turn runs a look, you press Dismiss, or you press Run check. It hides while a turn runs.

**Run check** sends one prompt: check the changed UI on the iOS simulator and Android emulator (or a phone-width browser for web), in light and dark mode, and show the screenshots.

## Usage cost

The band costs nothing. Run check starts one turn.

## Tests

`tests/phone-check-nudge.test.tsx` covers the file and look rules, a UI edit raising the band on the terminal and desktop surfaces, Run check sending the prompt, a turn with a simulator screenshot raising nothing, and Dismiss.

```sh
claude plugin test ~/.claude/mods/phone-check-nudge
```
