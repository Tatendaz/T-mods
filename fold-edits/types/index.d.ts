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

/** The part of a Bash result that holds the files the command changed. */
export type BashEditDiff = {
  files: { filePath: string; hunks: Hunk[]; created?: true; deleted?: true }[]
  moreFiles: number
}

declare module 'claude-code' {
  interface PluginState {
    'fold-edits': { isOpen: StateFamily<boolean> }
  }
}
