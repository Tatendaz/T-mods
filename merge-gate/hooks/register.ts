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
  /** The PR as typed: a number, a URL or a branch; absent for the current branch's PR. */
  pr?: string
  repo?: string
  /** The directory a `cd` before the merge moved to. */
  cwd?: string
  isAdmin: boolean
  /** The SHA a `--match-head-commit` already pins, if any. */
  matchHead?: string
}

export type MergeScan = { kind: 'none' } | { kind: 'refuse'; reason: string } | { kind: 'merge'; target: MergeTarget }

const WRAPPERS = new Set(['command', 'exec', 'env', 'sudo', 'nohup', 'time', 'builtin'])
const PR_MERGE = /\bpr\s+merge\b/g
const OTHER_MERGE = /mergePullRequest|pulls\/[^\s/'"]+\/merge\b/i

/** Splits a shell line into words, keeping quoted runs whole. */
export function words(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/**
 * Finds the one `gh pr merge` a Bash command runs, with its PR, repo and the
 * `cd` before it. It fails closed: a merge it cannot read plainly (more than
 * one, one inside `bash -c` or `$(...)`, a REST or GraphQL merge, GH_HOST set)
 * is refused rather than let through unchecked.
 */
export function scanMerge(command: string): MergeScan {
  const merges: MergeTarget[] = []
  let cwd: string | undefined
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const w = words(segment.trim())
    const env: Record<string, string> = {}
    for (;;) {
      if (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) {
        const [key, ...value] = w.shift()!.split('=')
        env[key!] = value.join('=')
      } else if (w.length > 0 && WRAPPERS.has(w[0]!)) w.shift()
      else break
    }
    const exe = (w[0] ?? '').split('/').pop()
    if (exe === 'cd' && w[1]) cwd = w[1]
    if (exe !== 'gh' || w[1] !== 'pr' || w[2] !== 'merge') continue
    if (env.GH_HOST !== undefined || env.GH_ENTERPRISE_TOKEN !== undefined) {
      return { kind: 'refuse', reason: 'merge-gate: GH_HOST is set in front of the merge, so the gate cannot check the same PR gh would merge.' }
    }
    const target: MergeTarget = { isAdmin: false, ...(cwd ? { cwd } : {}), ...(env.GH_REPO ? { repo: env.GH_REPO } : {}) }
    for (let i = 3; i < w.length; i++) {
      const word = w[i]!
      if (word === '--repo' || word === '-R') target.repo = w[++i]
      else if (word.startsWith('--repo=')) target.repo = word.slice(7)
      else if (word.startsWith('-R') && word.length > 2) target.repo = word.slice(2).replace(/^=/, '')
      else if (/^--admin(=|$)/.test(word)) target.isAdmin = true
      else if (word === '--match-head-commit') target.matchHead = w[++i]
      else if (word.startsWith('--match-head-commit=')) target.matchHead = word.slice(20)
      else if (/^-(b|t|-body|-subject|-body-file|F|A|-author-email)$/.test(word)) i++
      else if (!word.startsWith('-') && target.pr === undefined) target.pr = word
    }
    const url = target.pr?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
    if (url) {
      target.repo = url[1]
      target.pr = url[2]
    }
    merges.push(target)
  }

  const hidden = (command.match(PR_MERGE) ?? []).length > merges.length || OTHER_MERGE.test(command)
  if (merges.length > 1) return { kind: 'refuse', reason: 'merge-gate: one `gh pr merge` per command, so each PR is checked.' }
  if (hidden) {
    return {
      kind: 'refuse',
      reason:
        'merge-gate: this command merges in a way the gate cannot check (inside another command, through the REST or GraphQL API, or more than once). ' +
        'Run `gh pr merge <n> --squash --delete-branch` on its own. If the text only mentions a merge, write it with a file tool instead.',
    }
  }
  return merges.length === 1 ? { kind: 'merge', target: merges[0]! } : { kind: 'none' }
}

/** Pins the merge to the head that was checked, so gh refuses it if a push lands in between. */
export function pinHead(command: string, sha: string): string {
  if (/--match-head-commit/.test(command)) return command
  return command.replace(/((?:^|[\s;&|(])(?:\S*\/)?gh\s+pr\s+merge)\b/, `$1 --match-head-commit ${sha}`)
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

export type Verdict = { isClean: true; summary: string; headSha: string } | { isClean: false; problems: string[]; hint?: string }

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

  const reviewedHead = review.head_sha === pr.headRefOid
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
  return { isClean: true, headSha: pr.headRefOid, summary: `#${pr.number} at ${pr.headRefOid.slice(0, 7)}: CI green, reviewed, 0 open threads` }
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
  const review = await json<Review>(
    $,
    ['python3', `${await home($)}/${SCRIPTS}/coderabbit_status.py`, '--repo', repo, '--pr', String(pr.number)],
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
    if (target.isAdmin) return { deny: 'merge-gate: --admin bypasses branch rules. The owner never allows it.' }

    const verdict = await check($, target, astraRepos)
    if (!verdict.isClean) {
      const list = verdict.problems.map(p => `- ${p}`).join('\n')
      return { deny: `merge-gate: not clean, so not merged.\n${list}${verdict.hint ? `\n${verdict.hint}` : ''}` }
    }
    if (target.matchHead !== undefined && target.matchHead !== verdict.headSha) {
      return { deny: `merge-gate: --match-head-commit ${target.matchHead} is not the head that was checked (${verdict.headSha.slice(0, 7)}).` }
    }
    $.ui.toast(`merge-gate: ${verdict.summary}`)
    return next({ ...e, command: pinHead(e.command, verdict.headSha) })
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { deny: 'merge-gate: could not check this merge (gh or coderabbit_status.py failed). Check the PR by hand, or ask the owner.' },
  )
}
