import { describe, expect, test } from 'claude-code/testing'

import { buildBoard, prRow, summary } from '../hooks/register'

const NOW = Date.parse('2026-10-16T20:00:00Z')
const ROOT = '/Users/me/Projects/openlink'

const openPrs = [
  {
    number: 169,
    title: 'Migrations for invites',
    isDraft: false,
    statusCheckRollup: [
      { __typename: 'CheckRun', workflowName: 'CI', name: 'Migrations apply', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-11T17:27:47Z' },
      { __typename: 'CheckRun', workflowName: 'CI', name: 'Migrations apply', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-11T17:29:47Z' },
    ],
  },
  {
    number: 170,
    title: 'Landing motion',
    isDraft: false,
    statusCheckRollup: [
      { __typename: 'CheckRun', workflowName: 'CI', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-16T19:00:00Z' },
      { __typename: 'StatusContext', context: 'review-failover', state: 'SUCCESS' },
    ],
  },
]

const agents = [
  { agent_status: 'blocked', cwd: `${ROOT}/.claude/worktrees/p4-03`, name: 'p4-03', agent_session: { value: 'a' } },
  { agent_status: 'working', cwd: `${ROOT}/.claude/worktrees/p8-02`, name: 'p8-02', agent_session: { value: 'b' } },
  { agent_status: 'idle', cwd: ROOT, agent_session: { value: 'self' } },
  { agent_status: 'idle', cwd: '/Users/me/Projects/cv', agent_session: { value: 'c' } },
]

const input = {
  now: NOW,
  root: ROOT,
  repo: 'Tatendaz/builtby',
  open: openPrs,
  merged: [
    { number: 168, title: 'Fresh merge', mergedAt: '2026-10-16T12:00:00Z' },
    { number: 150, title: 'Old merge', mergedAt: '2026-10-10T12:00:00Z' },
  ],
  agents,
  selfId: 'self',
}

describe('swarm-board', () => {
  test('a PR row reads the newest CI run and the backup review', () => {
    expect(prRow(openPrs[0]!)).toMatchObject({ ci: 'red', review: 'none', red: ['Migrations apply'] })
    expect(prRow(openPrs[1]!)).toMatchObject({ ci: 'green', review: 'passed' })
  })

  test('the board lists what needs the owner, skips this session and old merges', () => {
    const b = buildBoard(input)
    expect(b.needsYou).toEqual(['agent p4-03 is waiting for an answer (p4-03)', '#169 CI red: Migrations apply'])
    expect(b.merged.map(m => m.number)).toEqual([168])
    expect(b.agents.map(a => a.name)).toEqual(['p4-03', 'p8-02'])
    expect(b.idleElsewhere).toBe(1)
    expect(summary(b)).toMatch(/2 open PRs, 1 merged in 24h/)
  })

  test('the pane draws the board on both surfaces', async ($, on) => {
    on('session.cwd' as never, (() => ({ value: ROOT })) as never)
    on('session.id' as never, (() => ({ value: 'self' })) as never)
    on('clock.now' as never, (() => ({ value: NOW })) as never)
    on('clock.every' as never, (() => ({ value: undefined })) as never)
    on('command.register' as never, (() => ({})) as never)
    on('ui.open' as never, (() => ({ value: { isPlaced: true } })) as never)
    on('process.run', ((_$: unknown, e: { argv: readonly string[] }) => {
      const a = e.argv.join(' ')
      const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
      if (a.startsWith('git rev-parse --show-toplevel')) return out(`${ROOT}\n`)
      if (a.startsWith('git rev-parse --path-format')) return out(`${ROOT}/.git\n`)
      if (a.startsWith('gh repo view')) return out('Tatendaz/builtby\n')
      if (a.includes('--state open')) return out(JSON.stringify(openPrs))
      if (a.includes('--state merged')) return out(JSON.stringify(input.merged))
      if (a.startsWith('herdr agent list')) return out(JSON.stringify({ result: { agents } }))
      return { value: { exitCode: 1, stdout: '', stderr: 'unexpected' } }
    }) as never)

    const ran = await $.command.run({ command: 'board', args: '' } as never)
    expect(ran.text).toMatch(/Tatendaz\/builtby: 2 open PRs/)
    expect(ran.text).toMatch(/Needs you: agent p4-03/)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'swarm-board',
        surface,
        component: 'Pane',
        requestId: 'swarm-board',
        props: { title: 'Board', isFocused: false, bodyColumns: 90, placement: 'dock' },
      } as never)
      expect(await ui.find({ type: 'Text', text: /#169 CI red · no review/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /#170 CI ok · reviewed/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /blocked\s+p4-03/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
