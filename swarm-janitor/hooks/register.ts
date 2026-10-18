import type { EngineInterface, Register } from 'claude-code'

// The owner kept asking to "close the agents that are idle" and "once agents
// are done and PR is merged and all green just kill them and the herdr tab".
// Every 3 minutes one session (the leader, picked through a lock file so 40
// open sessions do not all do it) closes the tab of each idle or done agent
// whose worktree branch has a merged PR and no uncommitted work, and pushes
// the owner's phone once when an agent stays blocked. No model call.

const TICK_MS = 3 * 60_000
const LEASE_MS = 7 * 60_000

export type Agent = {
  agent_status?: string
  cwd?: string
  name?: string
  focused?: boolean
  pane_id?: string
  tab_id?: string
  terminal_title_stripped?: string
  agent_session?: { value?: string }
}

export type Ledger = {
  leader?: string
  at?: number
  blockedSince: Record<string, number>
  pushed: string[]
  closed: { tab: string; name: string; pr: number; at: number }[]
}

export const emptyLedger = (): Ledger => ({ blockedSince: {}, pushed: [], closed: [] })

/** Whether this session may act now: no other leader has renewed its lease. */
export function mayLead(ledger: Ledger, self: string, now: number): boolean {
  return ledger.leader === undefined || ledger.leader === self || now - (ledger.at ?? 0) > LEASE_MS
}

export const nameOf = (a: Agent) => a.name ?? a.terminal_title_stripped ?? (a.cwd ?? '').split('/').pop() ?? 'agent'

/** Updates blocked times and returns the agents to push about, at most once each per blocked spell. */
export function blockedToPush(ledger: Ledger, agents: readonly Agent[], now: number, minutes: number): Agent[] {
  const blocked = new Set<string>()
  const push: Agent[] = []
  for (const a of agents) {
    if (a.agent_status !== 'blocked' || !a.pane_id) continue
    blocked.add(a.pane_id)
    const since = (ledger.blockedSince[a.pane_id] ??= now)
    if (now - since >= minutes * 60_000 && !ledger.pushed.includes(a.pane_id)) {
      ledger.pushed.push(a.pane_id)
      push.push(a)
    }
  }
  for (const pane of Object.keys(ledger.blockedSince)) if (!blocked.has(pane)) delete ledger.blockedSince[pane]
  ledger.pushed = ledger.pushed.filter(p => blocked.has(p))
  return push
}

/** Agents worth checking for a merged PR: idle or done, in a worktree, not focused, not this session. */
export function closeCandidates(agents: readonly Agent[], self: string): Agent[] {
  return agents.filter(
    a =>
      (a.agent_status === 'idle' || a.agent_status === 'done') &&
      a.focused !== true &&
      a.agent_session?.value !== self &&
      a.tab_id !== undefined &&
      /\/\.?worktrees\//.test(a.cwd ?? ''),
  )
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function sh($: EngineInterface, argv: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs: 45_000 })
    return { ok: r.exitCode === 0, out: r.stdout.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

async function readLedger($: EngineInterface, path: string): Promise<Ledger> {
  try {
    if (!(await $.fs.exists(path))) return emptyLedger()
    return { ...emptyLedger(), ...(JSON.parse(await $.fs.read(path)) as Partial<Ledger>) }
  } catch {
    return emptyLedger()
  }
}

/** The merged PR for an agent's worktree branch, when the worktree is clean; null otherwise. */
async function mergedAndClean($: EngineInterface, cwd: string): Promise<number | null> {
  const dirs = await sh($, ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], cwd)
  const [gitDir, common] = dirs.out.split('\n')
  if (!dirs.ok || !gitDir || gitDir === common) return null
  const branch = (await sh($, ['git', 'branch', '--show-current'], cwd)).out
  if (!branch || branch === 'main' || branch === 'master') return null
  const status = await sh($, ['git', 'status', '--porcelain'], cwd)
  if (!status.ok || status.out !== '') return null
  const pr = await sh($, ['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1', '--json', 'number', '--jq', '.[0].number'], cwd)
  const n = Number(pr.out)
  return pr.ok && Number.isInteger(n) && n > 0 ? n : null
}

async function tick($: EngineInterface, options: { closeMerged: boolean; blockedMinutes: number }, force: boolean): Promise<string> {
  const now = await $.clock.now()
  const self = await $.session.id()
  const path = `${await home($)}/.claude/state/swarm-janitor.json`
  const ledger = await readLedger($, path)
  if (!force && !mayLead(ledger, self, now)) return `Another session (${ledger.leader?.slice(0, 8)}) is the janitor right now.`
  ledger.leader = self
  ledger.at = now

  const list = await sh($, ['herdr', 'agent', 'list'])
  if (!list.ok) {
    await $.fs.write(path, JSON.stringify(ledger, null, 2))
    return 'herdr agent list failed, so nothing was checked.'
  }
  const agents = ((JSON.parse(list.out) as { result?: { agents?: Agent[] } }).result?.agents ?? []) as Agent[]
  const report: string[] = []

  for (const a of blockedToPush(ledger, agents, now, options.blockedMinutes)) {
    const where = (a.cwd ?? '').replace(/^.*\/Projects\//, '')
    await sh($, [`${await home($)}/.claude/bin/phone-notify`, `agent ${nameOf(a)} blocked ${options.blockedMinutes}+ min in ${where}: needs your answer`])
    report.push(`pushed: ${nameOf(a)} blocked`)
  }

  if (options.closeMerged) {
    for (const a of closeCandidates(agents, self)) {
      const pr = await mergedAndClean($, a.cwd!)
      if (pr === null) continue
      const closed = await sh($, ['herdr', 'tab', 'close', a.tab_id!])
      if (!closed.ok) continue
      ledger.closed = [...ledger.closed, { tab: a.tab_id!, name: nameOf(a), pr, at: now }].slice(-50)
      report.push(`closed ${nameOf(a)} (#${pr} merged)`)
      $.ui.toast(`swarm-janitor: closed ${nameOf(a)} (#${pr} merged)`)
    }
  }

  await $.fs.write(path, JSON.stringify(ledger, null, 2))
  const blocked = Object.keys(ledger.blockedSince).length
  return [report.length > 0 ? report.join('; ') : 'Nothing to close.', `${agents.length} agents, ${blocked} blocked.`].join(' ')
}

export const register: Register = (on, options) => {
  const opts = {
    closeMerged: (options as Record<string, unknown>).closeMerged !== false,
    blockedMinutes: Number((options as Record<string, unknown>).blockedMinutes ?? 10) || 10,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'janitor', description: 'Close merged agents\' herdr tabs and check blocked agents now' })
    $.clock.every(TICK_MS, () => void tick($, opts, false).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'janitor' }, async $ => ({ text: await tick($, opts, true) }))
}
