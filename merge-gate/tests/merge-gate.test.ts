import { describe, expect, test } from 'claude-code/testing'

import { judge, mergeCommand, redChecks, scanMerge } from '../hooks/register'

const targetOf = (command: string) => {
  const scan = scanMerge(command)
  return scan.kind === 'merge' ? scan.target : scan.kind
}

const HEAD = '4b6c22173a1b661edf407b8e69f75f6f255aa8b9'

const greenPr = {
  number: 147,
  url: 'https://github.com/Tatendaz/builtby/pull/147',
  headRefOid: HEAD,
  isDraft: false,
  mergeable: 'MERGEABLE',
  body: 'Motion tokens.\n\nAstra review: 0 findings, 0 fixed.',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'review-failover', state: 'SUCCESS' },
  ],
  comments: [],
}

const cleanReview = { action: 'done', looks_clean: true, clean_is_fresh: true, unresolved_threads: 0, head_sha: HEAD, reason: 'backup review passed' }

function fakeGh(pr: object, review: object, probeArgv: string[][] = []) {
  return ($: unknown, e: { argv: readonly string[] }) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (e.argv[0] === 'gh') return out(JSON.stringify(pr))
    if (String(e.argv[1]).endsWith('coderabbit_status.py')) {
      probeArgv.push([...e.argv])
      return out(JSON.stringify(review))
    }
    return out('{"can_trigger_pr": true}')
  }
}

describe('scanMerge', () => {
  test('reads the plain form', () => {
    expect(targetOf('cd ~/Projects/openlink && gh pr merge 138 --repo Tatendaz/builtby --squash --delete-branch')).toEqual({
      method: '--squash',
      deleteBranch: true,
      cwd: '~/Projects/openlink',
      pr: '138',
      repo: 'Tatendaz/builtby',
    })
    expect(targetOf('gh pr merge https://github.com/Tatendaz/builtby/pull/9 --rebase')).toEqual({
      method: '--rebase',
      deleteBranch: false,
      pr: '9',
      repo: 'Tatendaz/builtby',
    })
    expect(targetOf('gh pr merge')).toEqual({ method: '--squash', deleteBranch: false })
  })

  test('refuses every form the gate cannot check exactly', () => {
    const refused = [
      'gh pr merge --squash --admin',
      'gh pr merge 1 --admin=true',
      'gh pr merge 1 && gh pr merge 2',
      'bash -c "gh pr merge 2"',
      'gh "pr" merge 2',
      'gh p\\r merge 2',
      '$(echo gh) pr merge 2',
      'GH_REPO=Tatendaz/other gh pr merge 3',
      'export GH_REPO=Tatendaz/other && gh pr merge 3',
      'GH_HOST=evil.example gh pr merge 2',
      'gh pr merge 5 -b "done; all good" --squash',
      'gh pr merge 5 -sR Tatendaz/other',
      'gh pr merge 5 --auto',
      'gh pr merge 5 --match-head-commit abc',
      'gh pr merge 5 --squash --merge',
      'gh pr merge 5 | tee log',
      'gh api -X PUT repos/Tatendaz/builtby/pulls/138/merge',
      'gh api graphql -f query=mutationmergePullRequest',
      'gh api -X POST repos/Tatendaz/builtby/merges -f base=main -f head=feat/x',
      'gh api graphql -f query=mutation{enablePullRequestAutoMerge(input:{pullRequestId:PR_1}){clientMutationId}}',
      'gh api graphql -f query=mutation{mergeBranch(input:{repositoryId:R_1,base:main,head:feat/x}){clientMutationId}}',
      'gh alias set m "pr merge"',
      'git commit -m "note: gh pr merge later"',
      'gh pr m$(echo erge) 5',
      'gh pr "mer"ge 5',
      'gh $SUB merge 5',
      '$GH pr merge 5',
      'G=gh; $G $P $M 5',
    ]
    for (const command of refused) expect([command, targetOf(command)]).toEqual([command, 'refuse'])
  })

  test('leaves commands with no merge alone', () => {
    expect(targetOf('gh pr view 138 --json state')).toBe('none')
    expect(targetOf('git merge main')).toBe('none')
    expect(targetOf('echo "$HOME"')).toBe('none')
    expect(targetOf('gh pr create --title x --body "$(cat body.md)"')).toBe('none')
    expect(targetOf('gh api repos/Tatendaz/builtby/pulls --jq ".[].number"')).toBe('none')
    expect(targetOf('"$HOME/.claude/bin/phone-notify" done')).toBe('none')
  })

  test('the merge that runs is built from the checked values', () => {
    expect(mergeCommand('Tatendaz/builtby', 138, 'abc123', { method: '--squash', deleteBranch: true })).toBe(
      'gh pr merge 138 --repo Tatendaz/builtby --match-head-commit abc123 --squash --delete-branch',
    )
  })
})

describe('redChecks', () => {
  test('a cancelled run that a re-run replaced does not count', () => {
    const rollup = [
      { __typename: 'CheckRun', workflowName: 'CI', name: 'Lint', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-11T17:27:47Z' },
      { __typename: 'CheckRun', workflowName: 'CI', name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-11T17:29:46Z' },
      { __typename: 'CheckRun', workflowName: 'CI', name: 'Migrations', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-11T17:27:52Z' },
    ]
    expect(redChecks(rollup)).toEqual({ red: ['Migrations failure'], hasCi: true })
  })
})

describe('judge', () => {
  test('a green, reviewed PR with the Astra line is clean', () => {
    expect(judge(greenPr, cleanReview, true).isClean).toBe(true)
  })

  test('red CI, a stale review, open threads and a missing Astra line are each named', () => {
    const verdict = judge(
      {
        ...greenPr,
        body: 'no line',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
      { ...cleanReview, head_sha: 'old', unresolved_threads: 2 },
      true,
    )
    expect(verdict.isClean).toBe(false)
    if (verdict.isClean) return
    expect(verdict.problems.join('\n')).toMatch(/e2e failure/)
    expect(verdict.problems.join('\n')).toMatch(/no clean review on head 4b6c221/)
    expect(verdict.problems.join('\n')).toMatch(/2 review threads/)
    expect(verdict.problems.join('\n')).toMatch(/Astra review/)
    expect(verdict.hint).toMatch(/coderabbit_budget\.py failover --repo Tatendaz\/builtby --pr 147/)
  })

  test('a clean verdict from an earlier push is not a review of this head', () => {
    const stale = judge(greenPr, { ...cleanReview, clean_is_fresh: false }, false)
    expect(stale.isClean).toBe(false)
    expect(stale.isClean ? '' : stale.problems.join('\n')).toMatch(/no clean review on head 4b6c221/)
  })

  test('a PR with no CI and a Night Shift PR are never clean', () => {
    const noCi = judge({ ...greenPr, statusCheckRollup: [] }, cleanReview, false)
    expect(noCi.isClean).toBe(false)
    const night = judge({ ...greenPr, body: 'Part of Tatendaz/ideas-inbox#17' }, cleanReview, false)
    expect(night.isClean ? '' : night.problems[0]).toMatch(/Night Shift/)
  })
})

type Ran = { deny?: string; isError?: boolean; text?: string; result?: unknown }
const denial = (ran: Ran) => ran.deny ?? (ran.isError ? ran.text : undefined)

function bottom(on: (event: never, hook: never) => unknown) {
  on('session.cwd' as never, (() => ({ value: '/tmp' })) as never)
  on('env.get' as never, (() => ({ value: '/Users/test' })) as never)
  on('tool.call' as never, (() => ({ result: 'merged' })) as never)
}

describe('the Bash gate', () => {
  test('a merge of a red PR is denied with the reasons', async ($, on) => {
    bottom(on as never)
    on('process.run', fakeGh({ ...greenPr, isDraft: true }, cleanReview) as never)
    const ran = (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 147 --repo Tatendaz/builtby --squash' })) as Ran
    expect(denial(ran)).toMatch(/it is a draft/)
  })

  test('a merge of a clean PR goes through', async ($, on) => {
    bottom(on as never)
    on('process.run', fakeGh(greenPr, cleanReview) as never)
    const ran = (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 147 --repo Tatendaz/builtby --squash' })) as Ran
    expect(denial(ran)).toBeUndefined()
  })

  test('the review probe judges the PR as it stands, not every comment since it opened', async ($, on) => {
    bottom(on as never)
    const probeArgv: string[][] = []
    on('process.run', fakeGh(greenPr, cleanReview, probeArgv) as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 147 --repo Tatendaz/builtby --squash' })
    const argv = probeArgv[0] ?? []
    expect(argv).toContain('--since')
    expect(Number.isNaN(Date.parse(argv.at(argv.indexOf('--since') + 1) ?? ''))).toBe(false)
  })

  test('the merge that runs is pinned to the checked head', async ($, on) => {
    on('session.cwd' as never, (() => ({ value: '/tmp' })) as never)
    on('env.get' as never, (() => ({ value: '/Users/test' })) as never)
    on('process.run', fakeGh(greenPr, cleanReview) as never)
    let ranCommand = ''
    on('tool.call' as never, ((_$: unknown, e: { command: string }) => {
      ranCommand = e.command
      return { result: 'merged' }
    }) as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 147 --repo Tatendaz/builtby --squash' })
    expect(ranCommand).toBe(`gh pr merge 147 --repo Tatendaz/builtby --match-head-commit ${HEAD} --squash`)
  })

  test('other commands pass untouched, and --admin is refused', async ($, on) => {
    bottom(on as never)
    expect(denial((await $.tool.call({ tool: 'Bash', command: 'git status' })) as Ran)).toBeUndefined()
    const admin = (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --admin' })) as Ran
    expect(denial(admin)).toMatch(/--admin/)
  })
})
