# swarm-janitor

Closes herdr tabs of finished swarm agents, and sends your phone a push when an agent waits on you too long.

## What it does

Every 3 minutes, one Claude Code session acts as the janitor. A lease in `~/.claude/state/swarm-janitor.json` makes sure only one session does it, so 40 open sessions do not all run it. The janitor renews the lease every pass, and the lease expires after 7 minutes.

The janitor runs `herdr agent list`, then:

- **Closes a tab** with `herdr tab close` when all of these are true: the agent is `idle` or `done`, it is not focused, it is not the janitor's own session, its folder is a git worktree, its branch is not `main` or `master`, `git status --porcelain` is empty, and `gh pr list --head <branch> --state merged` finds a PR. A toast names the agent and the PR.
- **Pushes your phone** through `~/.claude/bin/phone-notify` when an agent has been `blocked` for `blockedMinutes`. It pushes once per blocked spell. A new spell starts after the agent leaves `blocked`.

`/janitor` runs one pass now and prints what it did.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `closeMerged` | `true` | Close tabs of merged, clean worktree agents. |
| `blockedMinutes` | `10` | Minutes blocked before a push. |

## Limits

- It never restarts or nudges an agent. It only closes tabs and pushes.
- Two sessions that start at the same moment can both take the lease for one pass. A second close of the same tab fails with no effect, but a push can go out twice.

## Usage cost

None. It runs `herdr`, `git` and `gh`.

## Tests

`tests/swarm-janitor.test.ts` covers the lease, the push timing, which agents can be closed, and `/janitor` closing a merged agent and leaving an unmerged one, with fake `herdr`, `git` and `gh`.

```sh
claude plugin test ~/.claude/mods/swarm-janitor
```
