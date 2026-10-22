// Replay past Claude Code transcripts through the stop gate's rule, offline.
//
//   bun scripts/replay.ts [--root ~/.claude-3/projects] [--limit 3000] [--jev 300]
//
// For each turn end (the last assistant text before the person's next prompt)
// it computes the skip reason and the rule's verdict, and a weak label: was
// the next prompt a short nudge ("계속", "go on")? A nudge after a turn end
// suggests the turn stopped too early.
//
// Nothing leaves the machine unless --jev N is given: then up to N scrubbed
// last paragraphs are sent to Jev, half from turns the rule or a nudge flags,
// and the key is read from TYPESAFE_API_KEY. Results are written as JSONL under
// ~/.local/state/jev-harness/replay/.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JEV_ENDPOINT, parseResponse, probabilityOf, requestBody } from '../hooks/jev'
import { confusion, kappa } from '../hooks/report'
import { scrub } from '../hooks/scrub'
import { STOP_QUESTION, announcesByRule, lastParagraph, stopSkipReason } from '../hooks/stop-gate'

type Block = { type?: string; text?: string }
type Entry = { type?: string; isMeta?: boolean; sessionId?: string; promptId?: string; message?: { role?: string; content?: unknown } }

export type TurnEnd = {
  file: string
  sessionId?: string
  paragraph: string
  skipped?: string
  rule?: boolean
  next?: string
  weak: 'nudge' | 'other' | 'none'
}

const NUDGE = /^\s*(계속(해|해요|해줘|하세요|진행(해|해줘)?)?|진행(해|해요|해줘|하세요)?|해줘|ㄱ+|go( on| ahead)?|continue|keep going|proceed|do it|ok(ay)?|응|네|좋아)\s*[.!~]*\s*$/i

export function weakLabel(next: string | undefined): TurnEnd['weak'] {
  if (next === undefined) return 'none'

  return next.trim().length <= 20 && NUDGE.test(next) ? 'nudge' : 'other'
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const blocks = content as Block[]
  if (blocks.some(b => b.type === 'tool_result')) return undefined
  const text = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')

  return text === '' ? undefined : text
}

/** A prompt the person typed: user text that is not meta, a tool result or command output. */
const isPrompt = (entry: Entry, text: string): boolean =>
  entry.type === 'user' && entry.isMeta !== true && !/^\s*<(command-|local-command|system-reminder|task-notification|bash-)/.test(text)

/** Every turn end of one transcript, in order. */
export function turnEnds(file: string, lines: readonly string[]): TurnEnd[] {
  const out: TurnEnd[] = []
  let lastText: string | undefined
  let sessionId: string | undefined
  const close = (next: string | undefined): void => {
    if (lastText === undefined) return
    const paragraph = lastParagraph(lastText)
    const skipped = stopSkipReason({ stopHookActive: false, backgroundTasks: 0, scheduledTasks: 0, paragraph })
    out.push({ file, sessionId, paragraph, skipped, rule: skipped === undefined ? announcesByRule(paragraph) : undefined, next, weak: weakLabel(next) })
    lastText = undefined
  }
  for (const line of lines) {
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    sessionId ??= entry.sessionId
    const text = textOf(entry.message?.content)
    if (text === undefined) continue
    if (entry.type === 'assistant') lastText = text
    else if (isPrompt(entry, text)) close(text)
  }
  close(undefined)

  return out
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)

  return i >= 0 ? process.argv[i + 1] : undefined
}

async function askJev(key: string, paragraph: string): Promise<{ probability?: number; ms: number; error?: string }> {
  const started = performance.now()
  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: requestBody({ last_paragraph: paragraph }, { stop: STOP_QUESTION }),
      signal: AbortSignal.timeout(5000),
    })
    const ms = performance.now() - started
    if (!response.ok) return { ms, error: `http ${response.status}` }
    const parsed = parseResponse(await response.text(), { stop: STOP_QUESTION })

    return parsed.ok ? { ms, probability: probabilityOf(parsed.answers.stop!, 'announce') } : { ms, error: 'invalid' }
  } catch {
    return { ms: performance.now() - started, error: 'network' }
  }
}

async function main(): Promise<void> {
  const home = homedir()
  const root = (arg('--root') ?? join(home, '.claude-3', 'projects')).replace(/^~/, home)
  const limit = Number(arg('--limit') ?? 3000)
  const jevCount = Number(arg('--jev') ?? 0)

  const files = readdirSync(root)
    .flatMap(dir => {
      try {
        return readdirSync(join(root, dir)).filter(f => f.endsWith('.jsonl')).map(f => join(root, dir, f))
      } catch {
        return []
      }
    })
    .map(path => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  const ends: TurnEnd[] = []
  let read = 0
  for (const { path } of files) {
    if (ends.length >= limit) break
    ends.push(...turnEnds(path, readFileSync(path, 'utf8').split('\n')))
    read++
  }
  const sample = ends.slice(0, limit)

  const skipped = new Map<string, number>()
  for (const end of sample) if (end.skipped) skipped.set(end.skipped, (skipped.get(end.skipped) ?? 0) + 1)
  const judged = sample.filter(end => end.skipped === undefined)
  const labeled = judged.filter(end => end.weak !== 'none')
  const c = confusion(labeled.map(end => ({ rule: end.rule === true, jev: end.weak === 'nudge' })))
  const pct = (n: number, d: number): string => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`)

  console.log(`transcripts read: ${read} of ${files.length}, newest first`)
  console.log(`turn ends: ${sample.length}; skipped ${sample.length - judged.length} (${[...skipped].map(([k, v]) => `${k} ${v}`).join(', ')})`)
  console.log(`judged: ${judged.length}; rule flags ${judged.filter(e => e.rule).length} (${pct(judged.filter(e => e.rule).length, judged.length)})`)
  console.log(`with a next prompt: ${labeled.length}; followed by a nudge ${labeled.filter(e => e.weak === 'nudge').length} (${pct(labeled.filter(e => e.weak === 'nudge').length, labeled.length)})`)
  console.log(`rule vs nudge: both ${c.both}, rule only ${c.ruleOnly}, nudge only ${c.jevOnly}, neither ${c.neither}; kappa ${kappa(c)?.toFixed(2) ?? '-'}`)
  console.log(`rule as a predictor of a nudge: precision ${pct(c.both, c.both + c.ruleOnly)}, recall ${pct(c.both, c.both + c.jevOnly)}`)

  const outDir = join(home, '.local', 'state', 'jev-harness', 'replay')
  mkdirSync(outDir, { recursive: true })
  chmodSync(join(home, '.local', 'state', 'jev-harness'), 0o700)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rows: Record<string, unknown>[] = sample.map(end => ({ ...end, paragraph: scrub(end.paragraph, home), next: end.next === undefined ? undefined : scrub(end.next.slice(0, 200), home) }))

  if (jevCount > 0) {
    const key = process.env.TYPESAFE_API_KEY
    if (!key) throw new Error('--jev needs TYPESAFE_API_KEY in the environment')
    const flagged = judged.filter(e => e.rule || e.weak === 'nudge')
    const rest = judged.filter(e => !e.rule && e.weak !== 'nudge')
    const picks = [...flagged.slice(0, Math.ceil(jevCount / 2)), ...rest.slice(0, jevCount)].slice(0, jevCount)
    const results: { rule: boolean; nudge: boolean; probability: number; ms: number }[] = []
    let failures = 0
    for (const end of picks) {
      const answer = await askJev(key, scrub(end.paragraph, home))
      const row = rows[sample.indexOf(end)]!
      row.jev = answer.probability
      row.jevMs = Math.round(answer.ms)
      row.error = answer.error
      if (answer.probability === undefined) failures++
      else results.push({ rule: end.rule === true, nudge: end.weak === 'nudge', probability: answer.probability, ms: answer.ms })
    }
    const threshold = Number(arg('--threshold') ?? 0.7)
    const vsRule = confusion(results.map(r => ({ rule: r.rule, jev: r.probability >= threshold })))
    const withNext = results.filter((_, i) => picks[i]!.weak !== 'none')
    const vsNudge = confusion(withNext.map(r => ({ rule: r.nudge, jev: r.probability >= threshold })))
    const ms = results.map(r => r.ms).sort((a, b) => a - b)
    console.log(`jev: sent ${picks.length}, answered ${results.length}, failed ${failures}; p50 ${Math.round(ms[Math.floor(ms.length / 2)] ?? 0)} ms, p95 ${Math.round(ms[Math.floor(ms.length * 0.95)] ?? 0)} ms`)
    console.log(`rule vs jev (>= ${threshold}): both ${vsRule.both}, rule only ${vsRule.ruleOnly}, jev only ${vsRule.jevOnly}, neither ${vsRule.neither}; kappa ${kappa(vsRule)?.toFixed(2) ?? '-'}`)
    console.log(`nudge vs jev: both ${vsNudge.both}, nudge only ${vsNudge.ruleOnly}, jev only ${vsNudge.jevOnly}, neither ${vsNudge.neither}; jev precision for a nudge ${pct(vsNudge.both, vsNudge.both + vsNudge.jevOnly)}, recall ${pct(vsNudge.both, vsNudge.both + vsNudge.ruleOnly)}`)
  }

  const out = join(outDir, `${stamp}.jsonl`)
  writeFileSync(out, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  console.log(`written: ${out.replace(home, '~')}`)
}

if (import.meta.main) await main()
