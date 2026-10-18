import type { Register, SessionMessage } from 'claude-code'

// Compaction drops the owner's exact words: approvals get paraphrased, open
// questions vanish, and workers end up re-told "Owner merge approval (...),
// still in force". This hands the summarizer the owner's own prompts and asks
// it to keep every decision in them verbatim. It runs inside the compaction
// that was going to run anyway, so it costs no extra model call.

const MAX_PROMPTS = 60
const MAX_CHARS = 600

/** The prompts the person typed, oldest first: no tool results, no injected blocks. */
export function ownerPrompts(messages: readonly SessionMessage[]): string[] {
  return messages
    .filter(m => m.role === 'user' && (m.toolResults ?? []).length === 0)
    .map(m => m.text.trim())
    .filter(t => t.length > 0 && !t.startsWith('<') && !t.startsWith('This session is being continued'))
    .slice(-MAX_PROMPTS)
    .map(t => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)} [cut]` : t))
}

export function keepInstructions(prompts: readonly string[], earlier?: string): string {
  const rules = [
    'Keep a section named "Owner decisions" in the summary.',
    'In it, quote word for word every decision, approval, permission, rule, choice of option and open question from the owner\'s messages below, each with its date when the transcript shows one.',
    'Mark a decision the owner later reversed as replaced, and keep the newer one.',
    'List what still waits on the owner under "Waiting on the owner".',
    'Keep PR numbers, branch names, commit SHAs, file paths and commands exactly as written.',
  ]
  const quoted = prompts.map((p, i) => `${i + 1}. ${p.replace(/\n+/g, ' ')}`).join('\n')
  return [earlier?.trim(), rules.join(' '), prompts.length > 0 ? `The owner's messages, oldest first:\n${quoted}` : '']
    .filter(Boolean)
    .join('\n\n')
}

export const register: Register = on => {
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const prompts = ownerPrompts(e.messages)
    const result = await next({ ...e, instructions: keepInstructions(prompts, e.instructions) })
    if (!('skip' in result)) $.ui.toast(`compact-keeper: asked the summary to keep ${prompts.length} owner messages' decisions verbatim`)
    return result
  })
}
