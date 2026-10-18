# compact-keeper

Tells every compaction of the main conversation to keep your decisions word for word.

Before this, decisions got lost across `/compact`. In one builtby session you had to ask "can you save important details before I run compact", and every swarm worker prompt repeated "Owner merge approval (2026-09-26, still in force...)".

## What it does

On `session.compact` it collects the prompts you typed: up to the last 60, each cut at 600 characters, with tool results and injected blocks left out. It adds them to the summarizer's instructions with these rules:

- Keep an "Owner decisions" section that quotes every decision, approval, permission, rule, choice of option and open question.
- Mark a reversed decision as replaced.
- List what still waits on you under "Waiting on the owner".
- Keep PR numbers, branches, SHAs, paths and commands exactly.

Text you typed after `/compact` stays first. Subagent compactions are left alone.

## How it relates to compact-state.py

`~/.claude/hooks/compact-state.py` already saves git state and your last 8 prompts to a file, and prints the file back after compaction. This mod works one step earlier: it changes what the summary itself holds. The two do not conflict.

## Usage cost

No extra model call. The compaction runs anyway. Its input grows by the quoted prompts, at most about 36,000 characters.

## Tests

`tests/compact-keeper.test.ts` covers which messages count as yours, the instruction text, and a compaction receiving it. It has not been watched on a real `/compact` yet.

```sh
claude plugin test ~/.claude/mods/compact-keeper
```
