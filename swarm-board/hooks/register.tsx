import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Board, PrRow } from '../types'

// "whats the status on builtby? anything that needs my decision?" was asked
// about 20 times in 30 sessions, each one a full model turn of gh calls. This
// pane answers it from gh and herdr directly: no model call, no usage.

const PANE = 'swarm-board'
const REFRESH_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

const board = atom({ plugin: 'swarm-board', key: 'board' } as const, null)
const isLoading = atom({ plugin: 'swarm-board', key: 'isLoading' } as const, false)

type Check = {
  __typename?: string
  name?: string
  workflowName?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
  startedAt?: string
}
type RawPr = { number: number; title: string; isDraft: boolean; statusCheckRollup?: Check[] }
type RawMerged = { number: number; title: string; mergedAt: string }
type RawAgent = {
  agent_status?: string
  cwd?: string
  name?: string
  focused?: boolean
  terminal_title_stripped?: string
  agent_session?: { value?: string }
}

const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL'])
const REVIEWERS = new Set(['CodeRabbit', 'review-failover'])

function latest(rollup: readonly Check[]): Check[] {
  const newest = new Map<string, Check>()
  for (const c of rollup) {
    const key = c.context !== undefined ? `status:${c.context}` : `check:${c.workflowName ?? ''}/${c.name ?? ''}`
    const seen = newest.get(key)
    if (!seen || String(c.startedAt ?? '') >= String(seen.startedAt ?? '')) newest.set(key, c)
  }
  return [...newest.values()]
}

/** One open PR as a row: CI from its newest check runs, review from the CodeRabbit and review-failover statuses. */
export function prRow(raw: RawPr): PrRow {
  const checks = latest(raw.statusCheckRollup ?? [])
  const ci = checks.filter(c => c.context === undefined)
  const red = ci.filter(c => c.status === 'COMPLETED' && !GREEN.has(String(c.conclusion))).map(c => String(c.name))
  const running = ci.some(c => c.status !== 'COMPLETED')
  const reviews = checks.filter(c => c.context !== undefined && REVIEWERS.has(c.context))
  const failover = reviews.find(c => c.context === 'review-failover')
  const review: PrRow['review'] =
    failover?.state === 'FAILURE' || failover?.state === 'ERROR'
      ? 'failed'
      : failover?.state === 'SUCCESS'
        ? 'passed'
        : reviews.some(c => c.state === 'PENDING')
          ? 'waiting'
          : 'none'
  return {
    number: raw.number,
    title: raw.title,
    isDraft: raw.isDraft,
    ci: ci.length === 0 ? 'none' : red.length > 0 ? 'red' : running ? 'running' : 'green',
    review,
    red,
  }
}

function place(cwd: string, root: string | null): string {
  const tree = cwd.match(/\/worktrees\/([^/]+)/)?.[1]
  if (tree) return tree
  if (root && cwd === root) return 'main checkout'
  return cwd.split('/').slice(-2).join('/')
}

/** Builds the board from what gh and herdr said. Pure, so the tests can feed it. */
export function buildBoard(input: {
  now: number
  root: string | null
  repo: string | null
  open: RawPr[]
  merged: RawMerged[]
  agents: RawAgent[]
  selfId: string
  error?: string | null
}): Board {
  const open = input.open.map(prRow)
  const mine = (a: RawAgent) => input.root === null || (a.cwd ?? '').startsWith(input.root)
  const others = input.agents.filter(a => a.agent_session?.value !== input.selfId)
  const agents: AgentRow[] = others.filter(mine).map(a => ({
    name: a.name ?? a.terminal_title_stripped ?? place(a.cwd ?? '', input.root),
    status: a.agent_status ?? 'unknown',
    place: place(a.cwd ?? '', input.root),
    isFocused: a.focused === true,
  }))
  const needsYou = [
    ...agents.filter(a => a.status === 'blocked').map(a => `agent ${a.name} is waiting for an answer (${a.place})`),
    ...open.filter(p => p.review === 'failed').map(p => `#${p.number} backup review found critical or high issues`),
    ...open.filter(p => p.ci === 'red' && !p.isDraft).map(p => `#${p.number} CI red: ${p.red.slice(0, 3).join(', ')}`),
  ]
  return {
    at: input.now,
    repo: input.repo,
    open,
    merged: input.merged.filter(m => input.now - Date.parse(m.mergedAt) < DAY_MS).map(m => ({ number: m.number, title: m.title })),
    agents,
    idleElsewhere: others.filter(a => !mine(a)).length,
    needsYou,
    error: input.error ?? null,
  }
}

const ORDER: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3 }

/** The board as plain text: what /board prints. */
export function summary(b: Board): string {
  const lines = [`${b.repo ?? 'No GitHub repo here'}: ${b.open.length} open PRs, ${b.merged.length} merged in 24h`]
  lines.push(b.needsYou.length > 0 ? `Needs you: ${b.needsYou.join('; ')}` : 'Needs you: nothing')
  const counts = new Map<string, number>()
  for (const a of b.agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
  if (b.agents.length > 0) lines.push(`Agents: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}`)
  if (b.error) lines.push(`Could not read: ${b.error}`)
  return lines.join('\n')
}

async function run($: EngineInterface, argv: string[], cwd: string): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd, timeoutMs: 45_000 })
  if (exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')}: ${(stderr || stdout).trim().split('\n')[0]?.slice(0, 120)}`)
  return stdout
}

async function load($: EngineInterface): Promise<Board> {
  const cwd = await $.session.cwd()
  const errors: string[] = []
  const attempt = async <T,>(what: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await what
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      return fallback
    }
  }
  const root = await attempt(run($, ['git', 'rev-parse', '--show-toplevel'], cwd).then(s => s.trim()), null as string | null)
  // A worktree's agents live under the main checkout, so the board groups by that.
  const common = root ? await attempt(run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd), '') : ''
  const mainRoot = common.trim().endsWith('/.git') ? common.trim().slice(0, -5) : root
  const repo = root
    ? await attempt(run($, ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd).then(s => s.trim()), null as string | null)
    : null
  const [open, merged, herdr] = await Promise.all([
    repo ? attempt(run($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '40', '--json', 'number,title,isDraft,statusCheckRollup'], cwd).then(s => JSON.parse(s) as RawPr[]), []) : [],
    repo ? attempt(run($, ['gh', 'pr', 'list', '--state', 'merged', '--limit', '20', '--json', 'number,title,mergedAt'], cwd).then(s => JSON.parse(s) as RawMerged[]), []) : [],
    attempt(run($, ['herdr', 'agent', 'list'], cwd).then(s => (JSON.parse(s) as { result?: { agents?: RawAgent[] } }).result?.agents ?? []), [] as RawAgent[]),
  ])
  return buildBoard({
    now: await $.clock.now(),
    root: mainRoot,
    repo,
    open,
    merged,
    agents: herdr,
    selfId: await $.session.id(),
    error: errors.length > 0 ? errors.join('; ') : null,
  })
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text)

let timer: { cancel: () => void } | null = null

async function refresh($: EngineInterface): Promise<Board> {
  await update($, isLoading, () => true)
  try {
    const fresh = await load($)
    await update($, board, () => fresh)
    return fresh
  } finally {
    await update($, isLoading, () => false)
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Board' })
  timer?.cancel()
  timer = $.clock.every(REFRESH_MS, () => void refresh($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Open PRs, merges, herdr agents and what needs you, live, with no model call' })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await openPane($)
    const fresh = await refresh($)
    return { text: summary(fresh) }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      timer?.cancel()
      timer = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const loading = await read($, isLoading)
    const width = Math.max(20, e.props.bodyColumns)
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 12)

    if (b === null) return <Text dimColor>{loading ? 'Reading gh and herdr…' : 'Run /board to load.'}</Text>

    const ciMark = { green: 'CI ok', red: 'CI red', running: 'CI …', none: 'no CI' } as const
    const reviewMark = { passed: 'reviewed', failed: 'review failed', waiting: 'review …', none: 'no review' } as const
    const agents = [...b.agents].sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9))
    const busy = agents.filter(a => a.status !== 'idle')
    const idle = agents.length - busy.length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold>{cut(b.repo ?? 'No GitHub repo here', width - 22)}</Text>
          <Text dimColor>{loading ? 'updating…' : `at ${clock(b.at)}`}</Text>
          <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
        </Box>

        <Text bold color={b.needsYou.length > 0 ? 'warning' : undefined}>
          Needs you{b.needsYou.length === 0 ? ': nothing' : ''}
        </Text>
        {b.needsYou.slice(0, room).map(line => (
          <Text color="warning">{cut(`  ${line}`, width)}</Text>
        ))}

        <Text bold>Open PRs ({b.open.length})</Text>
        {b.open.length === 0 && <Text dimColor>  none</Text>}
        {b.open.slice(0, room).map(p => (
          <Text color={p.ci === 'red' || p.review === 'failed' ? 'error' : undefined} dimColor={p.isDraft}>
            {cut(`  #${p.number} ${ciMark[p.ci]} · ${reviewMark[p.review]}${p.isDraft ? ' · draft' : ''}  ${p.title}`, width)}
          </Text>
        ))}

        <Text bold>Merged in 24h ({b.merged.length})</Text>
        {b.merged.slice(0, room).map(m => (
          <Text dimColor>{cut(`  #${m.number} ${m.title}`, width)}</Text>
        ))}

        <Text bold>
          Agents here ({b.agents.length}){idle > 0 ? `, ${idle} idle` : ''}
          {b.idleElsewhere > 0 ? `, ${b.idleElsewhere} in other folders` : ''}
        </Text>
        {busy.slice(0, room).map(a => (
          <Text color={a.status === 'blocked' ? 'warning' : undefined}>{cut(`  ${a.status.padEnd(8)} ${a.name} · ${a.place}`, width)}</Text>
        ))}

        {b.error && <Text dimColor>{cut(`Could not read: ${b.error}`, width)}</Text>}
      </Box>
    )
  })
}
