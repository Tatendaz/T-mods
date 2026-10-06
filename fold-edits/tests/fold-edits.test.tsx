import { describe, expect, test } from 'claude-code/testing'

import { diffChunks } from '../hooks/register'

const EDIT_OUTPUT = {
  filePath: 'tests/db/invite-list.test.ts',
  oldString: 'a',
  newString: 'b',
  originalFile: 'a\n',
  structuredPatch: [{ oldStart: 38, oldLines: 1, newStart: 38, newLines: 1, lines: ['-const a = 1;', '+const a = 2;'] }],
  userModified: false,
  replaceAll: false,
}

const editRow = (id: string) =>
  ({
    plugin: 'fold-edits',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Edit', output: EDIT_OUTPUT, isErrored: false },
  }) as const

describe('fold-edits', () => {
  test('an edit shows one summary line and the diff only after a press', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...editRow(`edit-${surface}`), surface })
      expect((await ui.find({ type: 'Text', text: /Updated tests\/db\/invite-list\.test\.ts \(\+1 -1\)/ }))).toBeDefined()
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      expect((await ui.find({ key: 'toggle-pill' }))?.props.backgroundColor).toBe('#116329')
      expect(await ui.find({ key: 'toggle-bottom' })).toBeUndefined()

      await ui.press({ key: 'toggle' })
      expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')
      expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('▾ hide')
      expect((await ui.find({ key: 'toggle-bottom-pill' }))?.props.backgroundColor).toBe('#116329')

      await ui.press({ key: 'toggle-bottom' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.press({ key: 'toggle' })

      await ui.press({ key: 'toggle' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a diff too big for one Code element is split and stays numbered', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `+line number ${i} with some padding text`)
    const chunks = diffChunks([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3000, lines }])
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(10000)
    expect(chunks[1]?.startsWith(`@@ -1,0 +${chunks[0]!.split('\n').length},`)).toBe(true)
  })

  test('an edits-only group gets the pill and opens every diff', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const call = { tool_use_id: 'g1', tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: EDIT_OUTPUT }
      const ui = await $.ui.mount({
        plugin: 'fold-edits',
        surface,
        component: 'ToolGroup',
        requestId: `group-${surface}`,
        props: { calls: [call, { ...call, tool_use_id: 'g2' }], isActive: false, isExpanded: false },
      })
      expect(await ui.find({ type: 'Text', text: /Edited 2 files \(\+2 -2\)/ })).toBeDefined()
      expect((await ui.find({ key: 'toggle-pill' }))?.props.backgroundColor).toBe('#116329')
      expect(await ui.find({ type: 'Code' })).toBeUndefined()

      await ui.press({ key: 'toggle' })
      expect(await ui.findAll({ type: 'Code' })).toHaveLength(2)
      await ui.press({ key: 'toggle-bottom' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a light theme gets the pale green', async ($, on) => {
    on('config.list', () => ({ value: [{ key: 'theme', value: 'light-daltonized' }] }) as never)
    const ui = await $.ui.mount({ ...editRow('light'), surface: 'terminal' })
    expect((await ui.find({ key: 'toggle-pill' }))?.props.backgroundColor).toBe('#aceebb')
    await ui.unmount()
  })

  test('other tools are left alone', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine row</Text>
    })
    const ui = await $.ui.mount({
      plugin: 'fold-edits',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'b1', tool: 'Bash', output: { stdout: 'hi', stderr: '', interrupted: false }, isErrored: false },
    })
    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
    await ui.unmount()
  })

  test('a shell command that changed files keeps its output and folds the diff', async ($, on) => {
    const seen: unknown[] = []
    on('ui.render', ($, e) => {
      seen.push((e.props as { output?: unknown }).output)
      const { Text } = $.ui.resolve(e)
      return <Text>engine row</Text>
    })
    on('session.start', async (_$, e) => ({ cwd: e.cwd, sessionId: 's1' }) as never)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const bashEditDiff = {
      files: [
        { filePath: '/repo/src/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-x', '+y', '+z'] }] },
        { filePath: '/repo/src/b.ts', created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }] },
      ],
      moreFiles: 0,
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'fold-edits',
        surface,
        component: 'ToolResult',
        props: { tool_use_id: `b-${surface}`, tool: 'Bash', output: { stdout: 'done', stderr: '', interrupted: false, bashEditDiff }, isErrored: false },
      })
      expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Changed 2 files \(\+3 -1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Code' })).toBeUndefined()

      await ui.press({ key: 'toggle' })
      expect(await ui.find({ type: 'Text', text: /Created src\/b\.ts \(\+1 -0\)/ })).toBeDefined()
      expect((await ui.find({ type: 'Code' }))?.props.path).toBe('src/a.ts')
      await ui.press({ key: 'toggle-bottom' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.unmount()
    }
    // The engine drew the output without the diff, so it is not shown twice.
    expect(seen.some(output => typeof output === 'object' && output !== null && 'bashEditDiff' in output)).toBe(false)
  })
})
