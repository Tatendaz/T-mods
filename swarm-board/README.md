# swarm-board

`/board` opens a pane that answers "what's the status, and what needs me?" for the repo you are in. It reads `gh` and `herdr`, so no model turn runs.

In 30 sessions this question came up about 20 times, for example "whats the status on builtby? anything that needs my decision?". Each answer was a full Opus turn of `gh` calls.

## What the pane shows

- **Needs you**: herdr agents in `blocked` state, PRs whose `review-failover` status failed, and non-draft PRs with red CI.
- **Open PRs**: number, CI (`CI ok`, `CI red`, `CI …`, `no CI`), review (`reviewed`, `review failed`, `review …`, `no review`), title. CI reads only the newest run of each check.
- **Merged in 24h**.
- **Agents here**: herdr agents whose folder is inside this repo's main checkout, worktrees included. Idle ones are counted, not listed. Agents in other folders are counted too.

The pane refreshes every 60 seconds while it is open, and has a Refresh button. Closing the pane stops the timer. `/board` also prints a 3-line summary in the transcript.

Colors use the theme's `warning` and `error` keys, so the pane follows light and dark terminal themes.

## Usage cost

None. It runs `git`, `gh` and `herdr agent list`.

## Tests

`tests/swarm-board.test.tsx` covers the PR row rules, the "needs you" list, and `/board` drawing the pane on the terminal and desktop surfaces with fake `gh` and `herdr` output.

```sh
claude plugin test ~/.claude/mods/swarm-board
```
