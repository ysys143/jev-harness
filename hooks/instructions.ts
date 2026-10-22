// E1: instruction fragments that join the conversation only when their
// condition holds. Path conditions belong to .claude/rules with `paths`;
// these are for conditions a path cannot tell, such as what the person asks for.
//
// Claude Code's conversation only grows, and changing anything early in it
// rewrites the prompt cache. So a fragment is appended at the end of the turn
// whose prompt first meets its condition, once, and judged again only after a
// compaction, when the cache is rebuilt anyway.
import type { JevQuestion } from './jev'

export const INSTRUCTIONS_POINT = 'instructions'

export const MAX_FRAGMENT_CHARS = 4096
export const MAX_FRAGMENTS = 24

export type Fragment = {
  name: string
  when: string
  keywords: readonly string[]
  pin: boolean
  body: string
}

export type FragmentProblem = { file: string; reason: string }

/** One fragment file: `---` frontmatter with when, keywords and pin, then the body. */
export function parseFragment(file: string, text: string): Fragment | FragmentProblem {
  const name = file.replace(/\.md$/i, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return { file, reason: 'name must be letters, digits, - or _' }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return { file, reason: 'no frontmatter' }
  const fields = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line.trim())
    if (field) fields.set(field[1]!.toLowerCase(), field[2]!.trim().replace(/^(["'])(.*)\1$/, '$2'))
  }
  const body = match[2]!.trim()
  const pin = /^(true|yes)$/i.test(fields.get('pin') ?? '')
  const when = fields.get('when') ?? ''
  if (body === '') return { file, reason: 'empty body' }
  if (body.length > MAX_FRAGMENT_CHARS) return { file, reason: `body over ${MAX_FRAGMENT_CHARS} characters` }
  if (!pin && when === '') return { file, reason: 'no when: (or pin: true)' }
  const keywords = (fields.get('keywords') ?? '')
    .split(',')
    .map(keyword => keyword.trim())
    .filter(Boolean)

  return { name, when, keywords, pin, body }
}

export const isFragment = (value: Fragment | FragmentProblem): value is Fragment => 'body' in value

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a prompt names one of the fragment's keywords: whole words for Latin text, substrings otherwise. */
export function keywordHit(prompt: string, keywords: readonly string[]): boolean {
  const text = prompt.toLowerCase()

  return keywords.some(raw => {
    const keyword = raw.toLowerCase()
    if (/^[a-z0-9 _.-]+$/.test(keyword)) return new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}($|[^a-z0-9])`).test(text)

    return text.includes(keyword)
  })
}

// Measured with jev-1.14.0 on 10 requests x 3 conditions: requests that met a
// condition got 0.99-1.00, the others 0.00-0.78; live, a request to explain
// code reached 0.93 for a prose condition, so the default threshold is 0.95.
export function conditionQuestion(when: string): JevQuestion {
  return {
    type: 'choice',
    instructions: `Does this condition hold for the request? Condition: ${when}`,
    criteria: { applies: 'The condition holds for this request.', not: 'The condition does not hold for this request.' },
  }
}

/** The block appended for one fragment: named, so a later turn can tell it is already there. */
export function fragmentBlock(fragment: Fragment): string {
  return `<instruction name="${fragment.name}" source="jev-harness">\n${fragment.body}\n</instruction>`
}

/** The pinned fragments as one stable system-prompt section, in name order. */
export function pinnedSection(fragments: readonly Fragment[]): string | undefined {
  const pinned = fragments.filter(fragment => fragment.pin)
  if (pinned.length === 0) return undefined

  return pinned.map(fragmentBlock).join('\n\n')
}

/** FNV-1a over names and bodies: changes when any fragment does. */
export function fragmentsHash(fragments: readonly Fragment[]): string {
  let hash = 0x811c9dc5
  const text = fragments.map(f => `${f.name}\n${f.when}\n${f.pin}\n${f.keywords.join(',')}\n${f.body}`).join('\n\u0000\n')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

export type FragmentDecision = { name: string; rule: boolean; jev?: number; attach: boolean }

/**
 * Which candidate fragments to attach. A keyword hit attaches without asking
 * Jev; otherwise Jev's probability decides. With no answer, only hits attach.
 */
export function decideFragments(
  candidates: readonly Fragment[],
  rule: ReadonlyMap<string, boolean>,
  jev: ReadonlyMap<string, number>,
  threshold: number,
): FragmentDecision[] {
  return candidates.map(fragment => {
    const isHit = rule.get(fragment.name) === true
    const probability = jev.get(fragment.name)

    return { name: fragment.name, rule: isHit, jev: probability, attach: isHit || (probability !== undefined && probability >= threshold) }
  })
}
