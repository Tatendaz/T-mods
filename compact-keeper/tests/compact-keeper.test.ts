import { describe, expect, test } from 'claude-code/testing'

import { keepInstructions, ownerPrompts } from '../hooks/register'

const messages = [
  { role: 'user', text: 'All agents can merge and change production until we have users.', toolUses: [] },
  { role: 'assistant', text: 'Noted.', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false, result: null }] },
  { role: 'user', text: '<system-reminder>injected</system-reminder>', toolUses: [] },
  { role: 'user', text: 'I choose B for now', toolUses: [] },
] as never

describe('compact-keeper', () => {
  test('only the prompts the owner typed are kept, in order', () => {
    expect(ownerPrompts(messages)).toEqual(['All agents can merge and change production until we have users.', 'I choose B for now'])
  })

  test('the instructions quote the owner and keep what /compact was given', () => {
    const text = keepInstructions(['I choose B for now'], 'focus on the swarm')
    expect(text.startsWith('focus on the swarm')).toBe(true)
    expect(text).toMatch(/Owner decisions/)
    expect(text).toMatch(/1\. I choose B for now/)
  })

  test('a compaction is told to keep the decisions', async ($, on) => {
    let told = ''
    on('session.compact', ((_$: unknown, e: { instructions?: string }) => {
      told = e.instructions ?? ''
      return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
    }) as never)
    await $.session.compact({ messages } as never)
    expect(told).toMatch(/I choose B for now/)
  })
})
