import { describe, expect, test } from 'claude-code/testing'

import { blockedToPush, closeCandidates, emptyLedger, mayLead } from '../hooks/register'

const W = '/Users/me/Projects/openlink/.claude/worktrees'
const MIN = 60_000

describe('swarm-janitor', () => {
  test('one session leads until its lease runs out', () => {
    const ledger = { ...emptyLedger(), leader: 'a', at: 0 }
    expect(mayLead(ledger, 'a', 1)).toBe(true)
    expect(mayLead(ledger, 'b', 6 * MIN)).toBe(false)
    expect(mayLead(ledger, 'b', 8 * MIN)).toBe(true)
  })

  test('a blocked agent is pushed once, after the wait, and again only after a new block', () => {
    const ledger = emptyLedger()
    const blocked = [{ agent_status: 'blocked', pane_id: 'p1', name: 'p4-03' }]
    expect(blockedToPush(ledger, blocked, 0, 10)).toEqual([])
    expect(blockedToPush(ledger, blocked, 9 * MIN, 10)).toEqual([])
    expect(blockedToPush(ledger, blocked, 10 * MIN, 10).map(a => a.name)).toEqual(['p4-03'])
    expect(blockedToPush(ledger, blocked, 20 * MIN, 10)).toEqual([])
    blockedToPush(ledger, [{ agent_status: 'working', pane_id: 'p1' }], 21 * MIN, 10)
    expect(ledger.blockedSince).toEqual({})
    expect(blockedToPush(ledger, blocked, 22 * MIN, 10)).toEqual([])
    expect(blockedToPush(ledger, blocked, 32 * MIN, 10)).toHaveLength(1)
  })

  test('only idle or done worktree agents that are not focused and not this session are candidates', () => {
    const agents = [
      { agent_status: 'idle', cwd: `${W}/p4-03`, tab_id: 't1', agent_session: { value: 'x' } },
      { agent_status: 'done', cwd: `${W}/p6-23`, tab_id: 't2', agent_session: { value: 'y' } },
      { agent_status: 'working', cwd: `${W}/p8-02`, tab_id: 't3' },
      { agent_status: 'idle', cwd: `${W}/p8-01`, tab_id: 't4', focused: true },
      { agent_status: 'idle', cwd: `${W}/self`, tab_id: 't5', agent_session: { value: 'me' } },
      { agent_status: 'idle', cwd: '/Users/me/Projects/openlink', tab_id: 't6' },
    ]
    expect(closeCandidates(agents, 'me').map(a => a.tab_id)).toEqual(['t1', 't2'])
  })

  test('/janitor closes a merged, clean agent and leaves an unmerged one', async ($, on) => {
    const ran: string[] = []
    const files = new Map<string, string>()
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })
    on('session.id' as never, (() => ({ value: 'me' })) as never)
    on('clock.now' as never, (() => ({ value: 1_000 })) as never)
    on('env.get' as never, (() => ({ value: '/Users/me' })) as never)
    on('command.register' as never, (() => ({})) as never)
    on('clock.every' as never, (() => ({ value: undefined })) as never)
    on('fs.exists' as never, ((_$: unknown, e: { path: string }) => ({ value: files.has(e.path) })) as never)
    on('fs.read' as never, ((_$: unknown, e: { path: string }) => ({ value: files.get(e.path) })) as never)
    on('fs.write' as never, ((_$: unknown, e: { path: string; text: string }) => {
      files.set(e.path, e.text)
      return { value: undefined }
    }) as never)
    on('process.run', ((_$: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
      const a = e.argv.join(' ')
      ran.push(a)
      const merged = e.init?.cwd?.endsWith('/p4-03')
      if (a === 'herdr agent list')
        return out(
          JSON.stringify({
            result: {
              agents: [
                { agent_status: 'idle', cwd: `${W}/p4-03`, tab_id: 't1', name: 'p4-03', agent_session: { value: 'x' } },
                { agent_status: 'idle', cwd: `${W}/p4-04`, tab_id: 't2', name: 'p4-04', agent_session: { value: 'y' } },
              ],
            },
          }),
        )
      if (a.startsWith('git rev-parse')) return out(`${e.init?.cwd}/.git\n/Users/me/Projects/openlink/.git`)
      if (a.startsWith('git branch')) return out('feat/x')
      if (a.startsWith('git status')) return out('')
      if (a.startsWith('gh pr list')) return out(merged ? '147' : '')
      if (a.startsWith('herdr tab close')) return out('')
      return out('', 1)
    }) as never)

    const result = await $.command.run({ command: 'janitor', args: '' } as never)
    expect(result.text).toMatch(/closed p4-03 \(#147 merged\)/)
    expect(ran).toContain('herdr tab close t1')
    expect(ran).not.toContain('herdr tab close t2')
    expect(JSON.parse(files.get('/Users/me/.claude/state/swarm-janitor.json')!).leader).toBe('me')
  })
})
