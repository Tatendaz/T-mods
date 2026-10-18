import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Unchecked } from '../types'

// The owner kept asking "Did you check the rest of the app on simulators?".
// This notices a turn that edited UI files and ran nothing that looks at them,
// and offers the check above the prompt. Showing the band costs nothing; the
// Run check button starts one turn.

const unchecked = atom({ plugin: 'phone-check-nudge', key: 'unchecked' } as const, null)

const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|swift|kt)$|\/res\/layout\/[^/]+\.xml$/
const NOT_UI = /(^|\/)(tests?|__tests__|e2e|spec|\.claude|node_modules)\/|\.(test|spec|stories)\.[jt]sx?$|\.d\.ts$/
const LOOKS = /\bxcrun\s+simctl\b|\bidb\b|\badb\b|\bmaestro\b|\bplaywright\b|screenshot|\bcodeandconfirm\b|agent-browser|--headless/i
const LOOK_TOOL = /claude-in-chrome|computer-use|Claude_Browser|Claude_Preview/

export const CHECK_PROMPT =
  'Check the UI you just changed the way a person would see it: the iOS simulator and the Android emulator for app code, or a phone-width browser for web pages. ' +
  'Look at light and dark mode, and scroll the screens you touched. Show me the screenshots and list anything that looks wrong.'

export const isUiFile = (path: string) => UI_FILE.test(path) && !NOT_UI.test(path)
export const looksAtUi = (tool: string, command?: string) => LOOK_TOOL.test(tool) || (tool === 'Bash' && LOOKS.test(command ?? ''))

export const register: Register = on => {
  let touched = new Set<string>()
  let looked = false

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const input = e as { file_path?: string; notebook_path?: string; command?: string }
    const path = input.file_path ?? input.notebook_path
    if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && path && isUiFile(path)) touched.add(path)
    if (looksAtUi(String(e.tool), input.command)) looked = true
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) {
      if (looked) await update($, unchecked, () => null)
      else if (touched.size > 0) {
        const files = [...touched]
        await update($, unchecked, old => ({ files: [...new Set([...(old?.files ?? []), ...files])].slice(-20) }))
      }
      touched = new Set()
      looked = false
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pending = await read($, unchecked)
    if (pending === null || e.props.isWorking || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const names = pending.files.map(f => f.split('/').pop())
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '')
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color="warning">UI changed, not checked on a phone</Text>
        <Text dimColor>({shown})</Text>
        <Button
          key="run-check"
          label="Run check"
          variant="primary"
          onPress={async () => {
            await update($, unchecked, () => null)
            await $.prompt.submit({ text: CHECK_PROMPT })
          }}
        />
        <Button key="dismiss" label="Dismiss" onPress={() => update($, unchecked, () => null)} />
      </Box>
    )
  })
}
