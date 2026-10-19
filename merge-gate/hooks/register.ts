import type { EngineInterface, Register } from 'claude-code'

// Stops `gh pr merge` until the PR's head is clean by the owner's merge rule:
// every CI check green, a real review on this head (CodeRabbit or the
// review-failover backup), no unresolved threads, not a draft, no conflicts,
// not a Night Shift PR, and the "Astra review:" line on repos that need it.

const SCRIPTS = '.claude/skills/tatendaz-github/scripts'
const NIGHT_SHIFT = /ideas-inbox(#|\/issues\/)17\b/
const ASTRA_LINE = /Astra review:\s*\d+\s+findings?/i
const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL'])

export type MergeTarget = {
  /** The PR as typed: a number or a PR URL; absent for the current branch's PR. */
  pr?: string
  repo?: string
  /** The directory a `cd` before the merge moved to. */
  cwd?: string
  method: '--squash' | '--merge' | '--rebase'
  deleteBranch: boolean
}

export type MergeScan = { kind: 'none' } | { kind: 'refuse'; reason: string } | { kind: 'merge'; target: MergeTarget }

// Anything that looks like a merge once quotes and backslashes are gone.
const MERGE_TEXT = /\bpr\s+merge\b|mergePullRequest|\/merge\b|\bgh\s+alias\b/i
// What a plain merge command may hold: no expansion, substitution, quoting or redirection.
const PLAIN = /^[A-Za-z0-9_./~:@=,+\- \n&;]*$/

const PLAIN_FORM =
  'merge-gate: run the merge on its own in the plain form, `gh pr merge <number> --repo <owner/repo> --squash --delete-branch` ' +
  '(an optional `cd <dir> &&` before it). The gate checks that form and runs it pinned to the checked head. ' +
  'If the command only mentions a merge in text, write that text with a file tool.'

const EXPANDS = /[$`\\"'*?[{]/

/**
 * True when shell expansion could build a `gh` subcommand the text check
 * cannot see (`gh pr m$(echo erge) 5`, `$GH pr merge`): a segment that runs
 * gh, or whose command word itself expands, with an expanding character in
 * its first three words.
 */
export function hidesGhVerb(command: string): boolean {
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const w = segment.trim().split(/\s+/).filter(Boolean)
    while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift()
    const head = w.slice(0, 3)
    const exe = (w[0] ?? '').replace(/["']/g, '').split('/').pop()
    // "$HOME/bin/tool" names a literal tool; only an expanding last part could be gh.
    const exeExpands = /[$`]/.test(exe ?? '')
    if ((exe === 'gh' || exeExpands) && head.slice(exe === 'gh' ? 1 : 0).some(word => EXPANDS.test(word)) && (exe === 'gh' || head.length > 1)) return true
  }
  return false
}

/**
 * Accepts one form of merge only: optional `cd <dir> &&` segments, then
 * `gh pr merge [<number>|<url>] [--repo <owner/repo>] [--squash|--merge|--rebase]
 * [--delete-branch]`, nothing else. Any other command that mentions a merge is
 * refused. The hook then runs a merge it builds itself from the checked PR,
 * so nothing the command says beyond these fields reaches gh.
 */
export function scanMerge(command: string): MergeScan {
  if (hidesGhVerb(command)) return { kind: 'refuse', reason: PLAIN_FORM }
  if (!MERGE_TEXT.test(command.replace(/["'\\]/g, ''))) return { kind: 'none' }
  if (!PLAIN.test(command)) return { kind: 'refuse', reason: PLAIN_FORM }

  const segments = command.split(/&&|;|\n/).map(seg => seg.trim()).filter(Boolean)
  const merge = segments.pop()!.split(/\s+/)
  let cwd: string | undefined
  for (const seg of segments) {
    const w = seg.split(/\s+/)
    if (w.length !== 2 || w[0] !== 'cd') return { kind: 'refuse', reason: PLAIN_FORM }
    cwd = w[1]
  }
  if (merge[0] !== 'gh' || merge[1] !== 'pr' || merge[2] !== 'merge') return { kind: 'refuse', reason: PLAIN_FORM }

  const target: MergeTarget = { method: '--squash', deleteBranch: false, ...(cwd ? { cwd } : {}) }
  let methods = 0
  for (let i = 3; i < merge.length; i++) {
    const word = merge[i]!
    if (word === '--repo' || word === '-R') target.repo = merge[++i]
    else if (word.startsWith('--repo=')) target.repo = word.slice(7)
    else if (word === '--squash' || word === '-s') (target.method = '--squash'), methods++
    else if (word === '--merge' || word === '-m') (target.method = '--merge'), methods++
    else if (word === '--rebase' || word === '-r') (target.method = '--rebase'), methods++
    else if (word === '--delete-branch' || word === '-d') target.deleteBranch = true
    else if (/^\d+$/.test(word) && target.pr === undefined) target.pr = word
    else {
      const url = word.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/)
      if (!url || target.pr !== undefined) {
        return { kind: 'refuse', reason: `merge-gate: \`${word}\` is not allowed in a merge. ${word.startsWith('--admin') ? 'The owner never allows --admin.' : PLAIN_FORM}` }
      }
      target.repo = url[1]
      target.pr = url[2]
    }
  }
  if (methods > 1) return { kind: 'refuse', reason: 'merge-gate: pick one of --squash, --merge or --rebase.' }
  if (target.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(target.repo)) return { kind: 'refuse', reason: PLAIN_FORM }
  return { kind: 'merge', target }
}

/** The merge the hook runs: built from the checked PR, pinned to the checked head. */
export function mergeCommand(repo: string, number: number, sha: string, target: MergeTarget): string {
  return ['gh', 'pr', 'merge', String(number), '--repo', repo, '--match-head-commit', sha, target.method, ...(target.deleteBranch ? ['--delete-branch'] : [])].join(' ')
}

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

/** Keeps the newest run of each check: a re-run leaves the cancelled first run in the rollup. */
export function latestChecks(rollup: readonly Check[]): Check[] {
  const newest = new Map<string, Check>()
  for (const c of rollup) {
    const key = c.context !== undefined ? `status:${c.context}` : `check:${c.workflowName ?? ''}/${c.name ?? ''}`
    const seen = newest.get(key)
    if (!seen || String(c.startedAt ?? '') >= String(seen.startedAt ?? '')) newest.set(key, c)
  }
  return [...newest.values()]
}

/** Names every check on the head that is not green, and says whether any CI check ran at all. */
export function redChecks(rollup: readonly Check[]): { red: string[]; hasCi: boolean } {
  const red: string[] = []
  let hasCi = false
  for (const c of latestChecks(rollup)) {
    if (c.__typename === 'StatusContext' || c.state !== undefined) {
      if (c.state !== 'SUCCESS') red.push(`${c.context} ${String(c.state).toLowerCase()}`)
      continue
    }
    hasCi = true
    if (c.status !== 'COMPLETED') red.push(`${c.name} ${String(c.status).toLowerCase()}`)
    else if (!GREEN.has(String(c.conclusion))) red.push(`${c.name} ${String(c.conclusion).toLowerCase()}`)
  }
  return { red, hasCi }
}

type Review = {
  action?: string
  reason?: string
  looks_clean?: boolean
  clean_is_fresh?: boolean
  unresolved_threads?: number | null
  head_sha?: string | null
  rate_limited?: boolean
}

type Pr = {
  number: number
  url: string
  headRefOid: string
  isDraft: boolean
  mergeable: string
  body: string
  statusCheckRollup: Check[]
  comments: { body: string }[]
}

export type Verdict = { isClean: true; summary: string; headSha: string; number: number; repo: string } | { isClean: false; problems: string[]; hint?: string }

/** Judges a PR against the merge rule from what gh and coderabbit_status.py reported. */
export function judge(pr: Pr, review: Review, needsAstra: boolean): Verdict {
  const problems: string[] = []
  const repo = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1] ?? '<owner/repo>'
  let hint: string | undefined

  if (NIGHT_SHIFT.test(pr.body ?? '')) {
    return { isClean: false, problems: ['this is a Night Shift PR: the owner reads and merges those'] }
  }
  if (pr.isDraft) problems.push('it is a draft')
  if (pr.mergeable === 'CONFLICTING') problems.push('it has merge conflicts')

  const { red, hasCi } = redChecks(pr.statusCheckRollup ?? [])
  if (!hasCi) problems.push('no CI check has reported on this head yet')
  if (red.length > 0) problems.push(`not green: ${red.slice(0, 5).join(', ')}${red.length > 5 ? ` and ${red.length - 5} more` : ''}`)

  // clean_is_fresh = the clean verdict covers this head (CodeRabbit reviewed it, or review-failover passed on it),
  // not a clean review of an earlier push.
  const reviewedHead = review.head_sha === pr.headRefOid && review.clean_is_fresh === true
  if (!(review.action === 'done' && review.looks_clean === true && reviewedHead)) {
    problems.push(`no clean review on head ${pr.headRefOid.slice(0, 7)}: ${review.reason ?? review.action ?? 'unknown'}`)
    hint =
      `Request one through the budget: python3 ~/${SCRIPTS}/coderabbit_budget.py run --kind pr --repo ${repo} --pr ${pr.number} -- ` +
      `gh pr comment ${pr.number} --repo ${repo} --body '@coderabbitai review'. On exit 75 run ` +
      `python3 ~/${SCRIPTS}/coderabbit_budget.py failover --repo ${repo} --pr ${pr.number}.`
  }
  if ((review.unresolved_threads ?? 0) > 0) problems.push(`${review.unresolved_threads} review threads are unresolved`)

  if (needsAstra && ![pr.body ?? '', ...(pr.comments ?? []).map(c => c.body)].some(t => ASTRA_LINE.test(t))) {
    problems.push('no "Astra review: <n> findings, <n> fixed" line in the PR')
  }

  if (problems.length > 0) return { isClean: false, problems, ...(hint ? { hint } : {}) }
  return { isClean: true, headSha: pr.headRefOid, number: pr.number, repo, summary: `#${pr.number} at ${pr.headRefOid.slice(0, 7)}: CI green, reviewed, 0 open threads` }
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? '~'
}

async function resolveCwd($: EngineInterface, cd: string | undefined): Promise<string> {
  const base = await $.session.cwd()
  if (!cd) return base
  if (cd === '~' || cd.startsWith('~/')) return (await home($)) + cd.slice(1)
  return cd.startsWith('/') ? cd : `${base}/${cd}`
}

async function json<T>($: EngineInterface, argv: string[], cwd: string): Promise<T> {
  const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
  if (exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${(stderr || stdout).trim().slice(0, 300)}`)
  return JSON.parse(stdout) as T
}

async function check($: EngineInterface, target: MergeTarget, astraRepos: string[]): Promise<Verdict> {
  const cwd = await resolveCwd($, target.cwd)
  const fields = 'number,url,headRefOid,isDraft,mergeable,body,statusCheckRollup,comments'
  const pr = await json<Pr>(
    $,
    ['gh', 'pr', 'view', ...(target.pr ? [target.pr] : []), ...(target.repo ? ['--repo', target.repo] : []), '--json', fields],
    cwd,
  )
  const repo = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1] ?? target.repo ?? ''
  // --since now: the gate judges the PR as it stands (open threads, a fresh verdict on this head). Without it the
  // probe counts every bot comment since the PR opened as new, including its replies on threads already resolved,
  // and answers `address` forever on any PR that ever had a finding.
  const review = await json<Review>(
    $,
    ['python3', `${await home($)}/${SCRIPTS}/coderabbit_status.py`, '--repo', repo, '--pr', String(pr.number), '--since', new Date().toISOString()],
    cwd,
  )
  return judge(pr, review, astraRepos.includes(repo.toLowerCase()))
}

function budgetLine(status: { can_trigger_pr?: boolean; pr_triggers_last_hour?: number; hourly_limit_pr?: number; pr_cooldown_until?: string | null }): string {
  if (status.can_trigger_pr) return `CodeRabbit free · ${status.pr_triggers_last_hour ?? 0}/${status.hourly_limit_pr ?? '?'} this hour`
  const until = status.pr_cooldown_until ? new Date(status.pr_cooldown_until) : null
  const at = until && !Number.isNaN(until.getTime()) ? ` until ${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}` : ''
  return `CodeRabbit on hold${at} · use budget failover`
}

export const register: Register = (on, options) => {
  const astraRepos = String((options as Record<string, unknown>).astraRepos ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  const showBudget = (options as Record<string, unknown>).budgetStatus !== false

  on('session.start', async ($, e, next) => {
    if (showBudget) {
      const refresh = async () => {
        try {
          const status = await json<Parameters<typeof budgetLine>[0]>(
            $,
            ['python3', `${await home($)}/${SCRIPTS}/coderabbit_budget.py`, 'status'],
            await $.session.cwd(),
          )
          $.ui.status(budgetLine(status))
        } catch {
          $.ui.status(undefined)
        }
      }
      void refresh()
      $.clock.every(5 * 60_000, () => void refresh())
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const scan = scanMerge(e.command)
    if (scan.kind === 'none') return next(e)
    if (scan.kind === 'refuse') return { deny: scan.reason }
    const target = scan.target

    const verdict = await check($, target, astraRepos)
    if (!verdict.isClean) {
      const list = verdict.problems.map(p => `- ${p}`).join('\n')
      return { deny: `merge-gate: not clean, so not merged.\n${list}${verdict.hint ? `\n${verdict.hint}` : ''}` }
    }
    $.ui.toast(`merge-gate: ${verdict.summary}`)
    return next({ ...e, command: mergeCommand(verdict.repo, verdict.number, verdict.headSha, target) })
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { deny: 'merge-gate: could not check this merge (gh or coderabbit_status.py failed). Check the PR by hand, or ask the owner.' },
  )
}
