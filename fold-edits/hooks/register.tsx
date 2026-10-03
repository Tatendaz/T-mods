import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { FileResult, Hunk } from '../types'

const FOLDED_TOOLS = ['Edit', 'Write', 'NotebookEdit']
// A Code element takes at most 10000 characters; leave room for the hunk header.
const MAX_CHUNK_CHARS = 9000

// The Button label takes the terminal's own text color, which a plugin cannot
// set, so the green behind it follows the theme: deep on dark, pale on light.
const PILL_DARK = '#116329'
const PILL_LIGHT = '#aceebb'

const isOpen = atom({ plugin: 'fold-edits', key: 'isOpen' } as const, false)

function hunksOf(output: FileResult): Hunk[] {
  const hunks = output.structuredPatch ?? []
  if (hunks.length > 0 || output.type !== 'create' || output.content === undefined) {
    return hunks
  }
  const lines = output.content.split('\n').map(line => `+${line}`)

  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
}

function header(oldStart: number, lines: string[], newStart: number): string {
  const oldLines = lines.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const newLines = lines.filter(line => line.startsWith(' ') || line.startsWith('+')).length

  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
}

// Splits the hunks into unified-diff pieces that each fit one Code element,
// renumbering every piece so its line numbers stay right.
export function diffChunks(hunks: Hunk[], max = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  const push = (text: string) => {
    if (current !== '' && current.length + 1 + text.length > max) {
      chunks.push(current)
      current = ''
    }
    current = current === '' ? text : `${current}\n${text}`
  }

  for (const hunk of hunks) {
    let oldAt = hunk.oldStart
    let newAt = hunk.newStart
    let piece: string[] = []
    let size = 0
    let pieceOld = oldAt
    let pieceNew = newAt
    const flush = () => {
      if (piece.length > 0) push([header(pieceOld, piece, pieceNew), ...piece].join('\n'))
      piece = []
      size = 0
      pieceOld = oldAt
      pieceNew = newAt
    }
    for (const raw of hunk.lines) {
      const line = raw.length > max - 100 ? raw.slice(0, max - 100) : raw
      if (size + line.length + 1 > max - 100) flush()
      piece.push(line)
      size += line.length + 1
      if (line.startsWith(' ') || line.startsWith('-')) oldAt += 1
      if (line.startsWith(' ') || line.startsWith('+')) newAt += 1
    }
    flush()
  }
  if (current !== '') chunks.push(current)

  return chunks
}

export function summarize(output: FileResult): { verb: string; path: string; added: number; removed: number; chunks: string[] } {
  const hunks = hunksOf(output)
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }

  return {
    verb: output.type === 'create' ? 'Created' : 'Updated',
    path: output.filePath ?? output.notebook_path ?? 'file',
    added,
    removed,
    chunks: diffChunks(hunks),
  }
}

async function pillColor($: { config: { list: () => Promise<ReadonlyArray<{ key: string; value: unknown }>> } }): Promise<string> {
  let theme: unknown
  try {
    theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  } catch {
    // No settings to read: keep the dark-theme green.
  }

  return typeof theme === 'string' && theme.startsWith('light') ? PILL_LIGHT : PILL_DARK
}

function isFoldable(tool: string, isErrored: boolean, output: unknown): output is FileResult {
  return FOLDED_TOOLS.includes(tool) && !isErrored && typeof output === 'object' && output !== null
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const output = e.props.output
    if (!isFoldable(e.props.tool, e.props.isErrored, output)) {
      return next(e)
    }

    const { verb, path, added, removed, chunks } = summarize(output)
    if (chunks.length === 0) {
      return next(e)
    }

    const open = memberOf(isOpen, e)
    const isShown = await read($, open)
    const green = await pillColor($)
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const toggle = () => update($, open, value => !value)
    const pill = (key: string) => (
      <Box key={`${key}-pill`} backgroundColor={green} paddingX={1}>
        <Button key={key} plain label={isShown ? '▾ hide' : '▸ show diff'} onPress={toggle} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            {verb} {path} (+{added} -{removed}){' '}
          </Text>
          {pill('toggle')}
        </Box>
        {isShown && chunks.map(source => <Code source={source} format="diff" path={path} />)}
        {isShown && <Box>{pill('toggle-bottom')}</Box>}
      </Box>
    )
  })

  // The engine folds some edits (scratchpad ones) into one group line with no
  // way to see the code; give an edits-only group the same pill.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls } = e.props
    const isEditsOnly =
      !e.props.isExpanded &&
      calls.length > 0 &&
      calls.every(call => !call.isRunning && isFoldable(call.tool, call.isErrored, call.output))
    if (!isEditsOnly) {
      return next(e)
    }

    const files = calls.map(call => summarize(call.output as FileResult)).filter(file => file.chunks.length > 0)
    if (files.length === 0) {
      return next(e)
    }

    const open = memberOf(isOpen, e)
    const isShown = await read($, open)
    const green = await pillColor($)
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const toggle = () => update($, open, value => !value)
    const added = files.reduce((sum, file) => sum + file.added, 0)
    const removed = files.reduce((sum, file) => sum + file.removed, 0)
    const pill = (key: string) => (
      <Box key={`${key}-pill`} backgroundColor={green} paddingX={1}>
        <Button key={key} plain label={isShown ? '▾ hide' : '▸ show diff'} onPress={toggle} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            Edited {files.length === 1 ? files[0]!.path : `${files.length} files`} (+{added} -{removed}){' '}
          </Text>
          {pill('toggle')}
        </Box>
        {isShown &&
          files.map(file => (
            <Box flexDirection="column">
              {files.length > 1 && (
                <Text dimColor>
                  {file.verb} {file.path} (+{file.added} -{file.removed})
                </Text>
              )}
              {file.chunks.map(source => (
                <Code source={source} format="diff" path={file.path} />
              ))}
            </Box>
          ))}
        {isShown && <Box>{pill('toggle-bottom')}</Box>}
      </Box>
    )
  })
}
