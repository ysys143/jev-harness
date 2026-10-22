// Fold relevance, shadow only: before a compaction, ask Jev which earlier tool
// results the current request still needs, and record that beside what a
// size-and-age rule (context-fold's default policy) would fold. Compaction
// rebuilds the prompt cache anyway, so this is where such a judgment costs no
// cache. Nothing here changes the compaction.
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import type { JevQuestion } from './jev'
import { normalizePath, targetOfCommand, targetOfPath } from './tool-gate'

export const FOLD_POINT = 'fold'

export const MIN_FOLD_CHARS = 1000
const KEEP_RECENT_TURNS = 2
const KEEP_ERRORS_UNDER = 2000
const KEEP_TOOLS = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode'])

export type FoldCandidate = {
  id: string
  tool: string
  /** What Jev is shown: the tool, its target as tool-gate shows targets, and the size. */
  call: string
  chars: number
  turnsAgo: number
  /** Whether the size-and-age rule would fold it. */
  ruleFolds: boolean
}

// A prompt the person wrote: not a tool result, an injected <tag> block, or a /command.
const isPrompt = (message: SessionMessage): boolean => {
  const text = message.text.trimStart()

  return message.role === 'user' && (message.toolResults ?? []).length === 0 && text !== '' && !text.startsWith('<') && !text.startsWith('/')
}

/** For each message, how many prompts come after it. */
export function turnsAgoOf(messages: readonly SessionMessage[]): number[] {
  const out: number[] = []
  let prompts = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    out[i] = prompts
    if (isPrompt(messages[i]!)) prompts++
  }

  return out
}

/** The last prompt the person wrote, or undefined. */
export function currentRequest(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (isPrompt(messages[i]!)) return messages[i]!.text.trim()

  return undefined
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const
const OTHER_KEYS = ['pattern', 'url', 'query', 'description'] as const

/** How one tool call is shown: never the content, only what it was called on. */
export function describeCall(use: ToolUseSummary | undefined, home: string, cwd: string): string {
  if (use === undefined) return 'unknown call'
  const input = use.input as Record<string, unknown>
  if (typeof input.command === 'string') return `${use.tool} ${targetOfCommand(input.command, home, cwd)}`
  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string') return `${use.tool} ${targetOfPath(normalizePath(value, home, cwd), home, cwd)}`
  }
  for (const key of OTHER_KEYS) {
    const value = input[key]
    if (typeof value === 'string') return `${use.tool} "${value.slice(0, 120)}"`
  }

  return use.tool
}

export function ruleWouldFold(tool: string, chars: number, turnsAgo: number, isError: boolean): boolean {
  if (turnsAgo < KEEP_RECENT_TURNS || KEEP_TOOLS.has(tool)) return false
  if (isError && chars < KEEP_ERRORS_UNDER) return false

  return chars >= MIN_FOLD_CHARS
}

/** The largest tool results not yet folded, at most `limit`, largest first. */
export function foldCandidates(messages: readonly SessionMessage[], home: string, cwd: string, limit: number): FoldCandidate[] {
  const uses = new Map<string, ToolUseSummary>()
  for (const message of messages) for (const use of message.toolUses) uses.set(use.tool_use_id, use)
  const turnsAgo = turnsAgoOf(messages)
  const out: FoldCandidate[] = []
  messages.forEach((message, i) => {
    for (const result of message.toolResults ?? []) {
      if (result.text.length < MIN_FOLD_CHARS || result.text.startsWith('[folded ')) continue
      const use = uses.get(result.tool_use_id)
      const tool = use?.tool ?? 'unknown'
      const lines = result.text.split('\n').length
      out.push({
        id: result.tool_use_id,
        tool,
        call: `${describeCall(use, home, cwd)} (${lines} lines)`,
        chars: result.text.length,
        turnsAgo: turnsAgo[i] ?? 0,
        ruleFolds: ruleWouldFold(tool, result.text.length, turnsAgo[i] ?? 0, result.isError),
      })
    }
  })

  return out.sort((a, b) => b.chars - a.chars).slice(0, limit)
}

// Measured with jev-1.14.0 on 10 results of a bug-fix request: results the
// fix needed got 0.38-0.85 for "needed", the others 0.00-0.26.
export function foldQuestion(call: string): JevQuestion {
  return {
    type: 'choice',
    instructions: `Will the agent need the full output of this earlier tool call again to finish the current request? Tool call: ${call}`,
    criteria: { needed: 'The output is still needed for the current request.', done: 'The output is no longer needed for it.' },
  }
}
