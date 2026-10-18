# merge-gate

Stops `gh pr merge` until the PR's current head meets the merge-when-clean rule. A refused merge comes back to Claude as a tool error that lists each problem.

## What it checks

Before any Bash command that runs `gh pr merge`, it reads the PR with `gh pr view` and the review state with `~/.claude/skills/tatendaz-github/scripts/coderabbit_status.py`. The merge goes through only when all of these hold:

- Every CI check run is green. Only the newest run of each check counts, so a cancelled first run that a re-run replaced does not block. A head with no CI check at all is refused, because right after a push the checks have not reported yet.
- `coderabbit_status.py` says `action: done` and `looks_clean: true` for this exact head SHA. That means a real CodeRabbit review or a `review-failover` success, not the bare stamp `@coderabbitai ignore` leaves.
- 0 unresolved review threads.
- Not a draft, and no merge conflicts.
- Not a Night Shift PR (its body links `ideas-inbox#17`).
- On repos listed in `astraRepos`, the body or a comment holds `Astra review: <n> findings`.

It fails closed on any merge it cannot read plainly, and refuses:

- `--admin` in any form, including `--admin=true`.
- More than one `gh pr merge` in one command.
- A merge inside another command (`bash -c "..."`, `$(...)`) or any text with more `pr merge` mentions than plain merges. A commit message or `echo` that only mentions a merge is refused too; write such text with a file tool.
- A REST merge (`pulls/<n>/merge`) or a GraphQL `mergePullRequest`.
- `GH_HOST` set in front of the merge. `GH_REPO` in front is read and checked as the repo.

When the PR is clean, the command that runs gets `--match-head-commit <checked sha>`, so gh refuses the merge if a push lands between the check and the merge. A `--match-head-commit` already in the command must name the checked head.

When the review is missing, the refusal includes the `coderabbit_budget.py run` command to request one and the `failover` command to run on exit 75.

If `gh` or the status script fails, the merge is refused (the hook fails closed).

## Status line

Every 5 minutes it runs `coderabbit_budget.py status` and shows `CodeRabbit free · 1/5 this hour` or `CodeRabbit on hold until 21:40 · use budget failover`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `astraRepos` | `Tatendaz/builtby` | Comma-separated repos that need the Astra line. |
| `budgetStatus` | `true` | Shows the CodeRabbit budget in the status line. |

## Usage cost

None. It runs `gh` and two local Python scripts, and makes no model call.

## Tests

`tests/merge-gate.test.ts` covers command parsing, each bypass the gate refuses, the head pin, the superseded-run rule, each refusal reason, and the Bash hook end to end with a fake `gh`. The live merge path has not been run: the auto-mode classifier refused a test merge of an already-merged PR.

```sh
claude plugin test ~/.claude/mods/merge-gate
```
