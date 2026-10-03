export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type FileResult = {
  filePath?: string
  notebook_path?: string
  type?: 'create' | 'update'
  content?: string
  structuredPatch?: Hunk[]
}

declare module 'claude-code' {
  interface PluginState {
    'fold-edits': { isOpen: StateFamily<boolean> }
  }
}
