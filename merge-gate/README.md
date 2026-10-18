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

It accepts one form of merge only, and refuses every other command that mentions a merge:

```sh
cd <dir> && gh pr merge <number or PR URL> --repo <owner/repo> --squash --delete-branch
```

The `cd`, the PR, `--repo`, one of `--squash`/`--merge`/`--rebase` (or `-s`/`-m`/`-r`) and `--delete-branch` (`-d`) are optional. Anything else is refused: `--admin` in any form, `--auto`, a body or subject flag, a second merge, a pipe, quotes, `$`, backslashes, an environment assignment such as `GH_REPO=`, a merge inside `bash -c`, the REST `pulls/<n>/merge` endpoint, GraphQL `mergePullRequest`, and `gh alias`. The check runs on the text with quotes and backslashes removed, so `gh "pr" merge` is caught too. A commit message or `echo` that only mentions a merge is refused as well; write such text with a file tool.

When the PR is clean, the hook does not run the command as typed. It runs one it builds from the checked PR: `gh pr merge <number> --repo <owner/repo> --match-head-commit <checked sha> <method> [--delete-branch]`. So gh merges exactly the PR and head that were checked, and refuses if a push landed in between.

A command that runs `gh`, or whose command word expands (`$GH`), is refused when its first three words hold `$`, a backtick, a quote, a backslash or a glob, so `gh pr m$(echo erge) 5` is caught. A literal tool path such as `"$HOME/bin/tool"` is not affected.

Limits. This is a guardrail against Claude merging by mistake, not a wall against a shell that wants to merge. A script file that runs `gh pr merge`, or an existing gh alias that expands to `pr merge`, is not caught (on 2026-10-19 `gh alias list` held only `co: pr checkout`). The hard stop is a GitHub ruleset that requires the CI checks on `main`.

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

`tests/merge-gate.test.ts` covers the allowed form, 20 refused forms, the built merge command, the superseded-run rule, each refusal reason, and the Bash hook end to end with a fake `gh`. The live merge path has not been run: the auto-mode classifier refused a test merge of an already-merged PR.

```sh
claude plugin test ~/.claude/mods/merge-gate
```
