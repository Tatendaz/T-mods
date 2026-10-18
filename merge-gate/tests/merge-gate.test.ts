import { describe, expect, test } from 'claude-code/testing'

import { isApiMerge, judge, parseMerge, redChecks } from '../hooks/register'

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

const cleanReview = { action: 'done', looks_clean: true, unresolved_threads: 0, head_sha: HEAD, reason: 'backup review passed' }

function fakeGh(pr: object, review: object) {
  return ($: unknown, e: { argv: readonly string[] }) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (e.argv[0] === 'gh') return out(JSON.stringify(pr))
    if (String(e.argv[1]).endsWith('coderabbit_status.py')) return out(JSON.stringify(review))
    return out('{"can_trigger_pr": true}')
  }
}

describe('parseMerge', () => {
  test('reads the PR, repo and cd before the merge', () => {
    expect(parseMerge('cd ~/Projects/openlink && gh pr merge 138 --repo Tatendaz/builtby --squash --delete-branch')).toEqual({
      isAdmin: false,
      cwd: '~/Projects/openlink',
      pr: '138',
      repo: 'Tatendaz/builtby',
    })
    expect(parseMerge('gh pr merge https://github.com/Tatendaz/builtby/pull/9 --squash')).toEqual({ isAdmin: false, pr: '9', repo: 'Tatendaz/builtby' })
    expect(parseMerge('gh pr merge --squash --admin')).toEqual({ isAdmin: true })
    expect(parseMerge('gh pr merge 5 -b "done; all good" --squash')?.pr).toBe('5')
  })

  test('ignores commands that only mention a merge', () => {
    expect(parseMerge('gh pr view 138 --json state')).toBeNull()
    expect(parseMerge('echo "gh pr merge 1"')).toBeNull()
    expect(parseMerge('git merge main')).toBeNull()
    expect(isApiMerge('gh api -X PUT repos/Tatendaz/builtby/pulls/138/merge')).toBe(true)
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

  test('other commands pass untouched, and --admin is refused', async ($, on) => {
    bottom(on as never)
    expect(denial((await $.tool.call({ tool: 'Bash', command: 'git status' })) as Ran)).toBeUndefined()
    const admin = (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 1 --admin' })) as Ran
    expect(denial(admin)).toMatch(/--admin/)
  })
})
