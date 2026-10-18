import { describe, expect, test } from 'claude-code/testing'

import { CHECK_PROMPT, isUiFile, looksAtUi } from '../hooks/register'

const BAND = { plugin: 'phone-check-nudge', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } } as const

function bottom(on: any) {
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

async function editThenEnd($: any, calls: object[]) {
  for (const call of calls) await $.tool.call(call)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}

describe('phone-check-nudge', () => {
  test('UI files count, tests and config do not', () => {
    expect(isUiFile('/repo/src/app/landing.tsx')).toBe(true)
    expect(isUiFile('/repo/ios/Views/TreeView.swift')).toBe(true)
    expect(isUiFile('/repo/android/app/src/main/res/layout/main.xml')).toBe(true)
    expect(isUiFile('/repo/tests/unit/landing.test.tsx')).toBe(false)
    expect(isUiFile('/Users/me/.claude/mods/x/hooks/register.tsx')).toBe(false)
    expect(isUiFile('/repo/src/lib/db.ts')).toBe(false)
  })

  test('simulator, emulator and browser runs count as a look', () => {
    expect(looksAtUi('Bash', 'xcrun simctl io booted screenshot a.png')).toBe(true)
    expect(looksAtUi('Bash', 'adb exec-out screencap -p > a.png')).toBe(true)
    expect(looksAtUi('Bash', 'pnpm exec playwright test')).toBe(true)
    expect(looksAtUi('mcp__claude-in-chrome__computer')).toBe(true)
    expect(looksAtUi('Bash', 'pnpm lint')).toBe(false)
  })

  test('a UI edit with no look raises the band, and Run check sends one prompt', async ($, on) => {
    bottom(on)
    const sent: string[] = []
    on('prompt.submit', ((_$: unknown, e: { text: string }) => {
      sent.push(e.text)
      return { text: e.text }
    }) as never)
    await editThenEnd($, [{ tool: 'Edit', file_path: '/repo/src/app/landing.tsx', old_string: 'a', new_string: 'b' }])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as never)
      expect(await ui.find({ type: 'Text', text: /landing\.tsx/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await ui.press({ key: 'run-check' })
    expect(sent).toEqual([CHECK_PROMPT])
    await ui.unmount()
    const after = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await after.find({ key: 'run-check' })).toBeUndefined()
    await after.unmount()
  })

  test('a turn that also looked at the UI raises nothing, and Dismiss clears the band', async ($, on) => {
    bottom(on)
    await editThenEnd($, [
      { tool: 'Edit', file_path: '/repo/src/app/landing.tsx', old_string: 'a', new_string: 'b' },
      { tool: 'Bash', command: 'xcrun simctl io booted screenshot /tmp/a.png' },
    ])
    const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await quiet.find({ key: 'run-check' })).toBeUndefined()
    await quiet.unmount()

    await editThenEnd($, [{ tool: 'Write', file_path: '/repo/src/app/hero.css', content: 'a{}' }])
    const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } } as never)
    expect(await working.find({ key: 'run-check' })).toBeUndefined()
    await working.unmount()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'run-check' })).toBeUndefined()
    await ui.unmount()
  })
})
