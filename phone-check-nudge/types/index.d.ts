export type Unchecked = { files: string[] }

declare module 'claude-code' {
  interface PluginState {
    'phone-check-nudge': { unchecked: Unchecked | null }
  }
}
