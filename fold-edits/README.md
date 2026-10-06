# fold-edits

Claude Code prints the full diff under every Edit and Write call. A long session fills the screen with code you did not ask to read.

This mod replaces each diff with one line and a button that opens it:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/fold-edits-dark.svg">
  <img alt="fold-edits: an edit folded to one line with a green show diff button, then opened with hide buttons above and below the diff" src="docs/fold-edits-light.svg">
</picture>

Click **show diff** to open the diff. Click **hide** to fold it again. When the diff is open, a hide button sits at both the top and the bottom, so you do not have to scroll back up on a long diff.

## What it changes

- Edit, Write and NotebookEdit results. A failed edit is left as Claude Code draws it.
- Groups that hold only edits, such as Claude Code's "Made 1 scratchpad edit" line. A group that mixes edits with reads or shell commands is left alone.
- Shell commands that change files, such as a script, `sed -i` or a heredoc. Claude Code shows the command's output and then the full diff. The mod keeps the output and folds the diff into one line, for example "Changed 2 files (+3 -1)".

A diff longer than 10,000 characters, the limit for one code block, is split into several blocks. Line numbers stay correct across the split.

## Button color

A plugin cannot set a button's text color, so the mod picks the green behind the text from your theme:

- Dark themes get `#116329`, with light text on top.
- Light themes get `#aceebb`, with dark text on top.

If the mod cannot read the theme setting, it uses the dark green.

## Images

`docs/make_svgs.py` draws the two README images, one per theme. GitHub shows the one that matches the reader's theme. Run it again after a change to how the mod looks.

## Tests

```sh
claude plugin test ~/.claude/mods/fold-edits
```

The tests cover the summary line, opening and closing the diff, both button colors, diff splitting, edit-only groups, shell commands that change files, and leaving other tools alone.
