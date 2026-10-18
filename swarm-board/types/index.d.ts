export type PrRow = {
  number: number
  title: string
  isDraft: boolean
  ci: 'green' | 'red' | 'running' | 'none'
  review: 'passed' | 'failed' | 'waiting' | 'none'
  red: string[]
}

export type AgentRow = { name: string; status: string; place: string; isFocused: boolean }

export type Board = {
  at: number
  repo: string | null
  open: PrRow[]
  merged: { number: number; title: string }[]
  agents: AgentRow[]
  idleElsewhere: number
  needsYou: string[]
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'swarm-board': { board: Board | null; isLoading: boolean }
  }
}
