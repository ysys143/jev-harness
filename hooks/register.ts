import type { Args, EngineInterface, EventResult, Next, Register, SessionMessage } from 'claude-code'
import { admit, afterCall, readBudget } from './budget'
import { JEV_ENDPOINT, parseResponse, probabilityOf, requestBody, type JevQuestion, type JevResult } from './jev'
import { pickKey } from './key'
import { pointReport, type ShadowRecord } from './report'
import { scrub } from './scrub'
import { FOLD_POINT, currentRequest, foldCandidates, foldQuestion } from './fold-judge'
import {
  INSTRUCTIONS_POINT,
  MAX_FRAGMENTS,
  conditionQuestion,
  decideFragments,
  fragmentBlock,
  fragmentsHash,
  isFragment,
  keywordHit,
  parseFragment,
  pinnedSection,
  type Fragment,
} from './instructions'
import { STOP_MESSAGE, STOP_POINT, STOP_QUESTION, announcesByRule, lastParagraph, stopSkipReason } from './stop-gate'
import {
  TOOL_POINT,
  TOOL_QUESTION,
  canWrite,
  decideTrust,
  denyMessage,
  normalizePath,
  pathCandidates,
  pathFieldValues,
  restrictedReason,
  secretDumpReason,
  selfProtectReason,
  type FloorVerdict,
  riskOf,
  targetOfCommand,
  targetOfPath,
  type Trust,
} from './tool-gate'

type Mode = 'off' | 'shadow' | 'active'

const modeOf = (value: unknown): Mode => (value === 'shadow' || value === 'active' ? value : 'off')
const numberOf = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

type Settings = {
  stopGate: Mode
  toolGate: Mode
  stopThreshold: number
  timeoutMs: number
  stopCap: number
  toolJev: Mode
  toolThreshold: number
  toolCap: number
  providerTrust: 'auto' | 'external'
  trustedProxies: string[]
  apiKey: unknown
  instructions: Mode
  fragmentsDir: string
  instructionThreshold: number
  instructionCap: number
  foldJev: Mode
  foldCap: number
}

// Per process: reset on a reload, which only costs a mkdir and a lookup.
const madeDirs = new Set<string>()
let sequence = 0
const runtime: {
  settings?: Settings
  counts: { judged: number; failed: number; floor: number; toolJudged: number; attached: number; foldJudged: number; foldMissed: number }
  /** Whether this plugin's session.compact saw the compaction now ending. */
  sawCompaction?: boolean
  key?: { key: string; source: string } | null
  trust?: { trust: Trust; why: string }
  fragments?: { list: Fragment[]; hash: string; dir: string; problems: string[] }
} = { counts: { judged: 0, failed: 0, floor: 0, toolJudged: 0, attached: 0, foldJudged: 0, foldMissed: 0 } }

// Tool targets already judged in this process: one Jev call per target and session.
const toolVerdicts = new Map<string, { risk: number; choice: string }>()

const settingsOf = (): Settings => {
  if (runtime.settings === undefined) throw new Error('jev-harness: settings read before register')

  return runtime.settings
}

const homeOf = async ($: EngineInterface): Promise<string> => (await $.env.get('HOME')) ?? '/'

const logRootOf = async ($: EngineInterface): Promise<string> => `${await homeOf($)}/.local/state/jev-harness`

/** The key from the first source that has one: sensitive setting, the plugin's .env, the environment. */
const resolveKey = async ($: EngineInterface, configured: unknown): Promise<{ key: string; source: string } | undefined> => {
  const dotenvPath = `${$.plugin.root}/.env`
  const dotenv = (await $.fs.exists(dotenvPath)) ? await $.fs.read(dotenvPath) : undefined

  return pickKey({ config: configured, dotenv: typeof dotenv === 'string' ? dotenv : undefined, env: await $.env.get('TYPESAFE_API_KEY') })
}

/** Who serves the session: first-party only when every sign agrees. */
const resolveTrust = async ($: EngineInterface, override: 'auto' | 'external', trustedProxies: readonly string[]) => {
  const proxies = [await $.env.get('HTTPS_PROXY'), await $.env.get('https_proxy'), await $.env.get('HTTP_PROXY'), await $.env.get('http_proxy')]
  const thirdParty = [
    ['CLAUDE_CODE_USE_BEDROCK', await $.env.get('CLAUDE_CODE_USE_BEDROCK')],
    ['CLAUDE_CODE_USE_VERTEX', await $.env.get('CLAUDE_CODE_USE_VERTEX')],
    ['CLAUDE_CODE_USE_FOUNDRY', await $.env.get('CLAUDE_CODE_USE_FOUNDRY')],
  ]

  return decideTrust({
    isAuthorized: (await $.session.authorize()) !== null,
    baseUrl: await $.env.get('ANTHROPIC_BASE_URL'),
    proxies: proxies.filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
    caCerts: await $.env.get('NODE_EXTRA_CA_CERTS'),
    thirdParty: thirdParty.filter(([, v]) => typeof v === 'string' && v !== '' && v !== '0').map(([name]) => name as string),
    override,
    trustedProxies,
  })
}

/** One Jev call, raced against a timer; never throws. */
const askJev = async (
  $: EngineInterface,
  key: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  timeoutMs: number,
): Promise<JevResult> => {
  const started = await $.clock.now()
  const request = $.http
    .fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: requestBody(state, questions),
    })
    .then(
      response => ({ response }),
      () => ({ response: undefined }),
    )
  // A late answer is dropped: whichever settles first decides.
  const timer = $.clock.sleep(timeoutMs).then(() => 'timeout' as const)
  const winner = await Promise.race([request, timer])
  const ms = (await $.clock.now()) - started
  if (winner === 'timeout') return { ok: false, kind: 'timeout', ms }
  const { response } = winner
  if (response === undefined) return { ok: false, kind: 'network', ms }
  if (!response.ok) return { ok: false, kind: 'http', status: response.status, ms }
  const parsed = parseResponse(response.text, questions)

  return parsed.ok ? { ...parsed, ms } : { ok: false, kind: 'invalid', ms }
}

/** A Jev call within the point's session budget and circuit. */
const judge = async (
  $: EngineInterface,
  budget: { sessionId: string; point: string; cap: number },
  key: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  timeoutMs: number,
): Promise<JevResult> => {
  const storeKey = `budget:${budget.sessionId}:${budget.point}`
  const before = readBudget(await $.store.get(storeKey))
  const gate = admit(before, budget.cap, await $.clock.now())
  if (gate !== 'ok') return { ok: false, kind: gate, ms: 0 }
  const result = await askJev($, key, state, questions, timeoutMs)
  await $.store.set(storeKey, afterCall(before, result.ok, await $.clock.now()))

  return result
}

/** One record, one file, in a folder only the user can enter. */
const writeRecord = async ($: EngineInterface, record: ShadowRecord): Promise<void> => {
  const root = await logRootOf($)
  const dir = `${root}/${record.sessionId}/${record.point}`
  if (!madeDirs.has(dir)) {
    await $.process.run(['mkdir', '-p', root])
    await $.process.run(['chmod', '700', root])
    await $.process.run(['mkdir', '-p', dir])
    madeDirs.add(dir)
  }
  await $.fs.write(`${dir}/${record.id}.json`, JSON.stringify(record))
}

const newId = (now: number): string => `${Math.floor(now).toString(36)}${(sequence++ % 1296).toString(36).padStart(2, '0')}`

/** Every record under the log root, newest sessions first, at most `limit`. */
const readRecords = async ($: EngineInterface, limit: number): Promise<{ records: ShadowRecord[]; labels: Map<string, boolean> }> => {
  const root = await logRootOf($)
  const records: ShadowRecord[] = []
  const labels = new Map<string, boolean>()
  if (!(await $.fs.exists(root))) return { records, labels }
  for (const session of await $.fs.list(root)) {
    if (session.kind !== 'dir') continue
    const sessionDir = `${root}/${session.name}`
    for (const point of await $.fs.list(sessionDir)) {
      if (point.kind !== 'dir') continue
      for (const file of await $.fs.list(`${sessionDir}/${point.name}`)) {
        if (records.length >= limit || !file.name.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(await $.fs.read(`${sessionDir}/${point.name}/${file.name}`)) as ShadowRecord | { id: string; label: boolean }
          if (session.name === 'labels' && 'label' in parsed) labels.set(parsed.id, parsed.label)
          else records.push(parsed as ShadowRecord)
        } catch {
          // A partly written or foreign file is skipped.
        }
      }
    }
  }

  return { records, labels }
}

type ToolFacts = { tool: string; command?: string; candidates: readonly string[]; home: string; cwd: string; t0: number }

/**
 * Jev's judgment of a tool call the floor let through: only in an external
 * session, with a path or command shown in place of the file's contents.
 * Shadow runs the tool first and judges afterwards; active judges first.
 */
const judgeTool = async (
  $: EngineInterface,
  e: Args<'tool.call'>,
  next: Next<'tool.call'>,
  facts: ToolFacts,
): Promise<EventResult<'tool.call'>> => {
  const settings = settingsOf()
  const mode = settings.toolJev
  if (mode === 'off') return next(e)
  const trust = await trustFor($)
  if (trust.trust !== 'external') return next(e)
  const key = await keyFor($)
  const first = facts.candidates[0]
  const shown =
    facts.command !== undefined
      ? targetOfCommand(facts.command, facts.home, facts.cwd)
      : first === undefined
        ? undefined
        : targetOfPath(normalizePath(first, facts.home, facts.cwd), facts.home, facts.cwd)
  if (key === undefined || shown === undefined) return next(e)

  const sessionId = await $.session.id()
  const sent = { tool: facts.tool, target: scrub(shown, facts.home) }
  const cacheKey = `${sessionId}\n${sent.tool}\n${sent.target}`
  const hookMs = (await $.clock.now()) - facts.t0
  const base = { id: newId(facts.t0), ts: new Date(facts.t0).toISOString(), sessionId, joinKey: e.tool_use_id, point: TOOL_POINT, mode }

  const verdictOf = async (): Promise<{ risk: number; choice: string } | undefined> => {
    const known = toolVerdicts.get(cacheKey)
    if (known !== undefined) return known
    const result = await judge($, { sessionId, point: 'tool-jev', cap: settings.toolCap }, key.key, sent, { data: TOOL_QUESTION }, settings.timeoutMs)
    const answer = result.ok ? result.answers.data : undefined
    const verdict = answer === undefined ? undefined : { risk: riskOf(answer.probabilities), choice: String(answer.value) }
    if (verdict !== undefined) {
      toolVerdicts.set(cacheKey, verdict)
      runtime.counts.toolJudged++
    }
    await writeRecord($, {
      ...base,
      heuristic: false,
      sent,
      jev: verdict?.risk,
      usage: result.ok ? result.usage : undefined,
      error: result.ok ? undefined : result.kind === 'http' ? `http ${result.status ?? 0}` : result.kind,
      jevMs: result.ms,
      // Active holds the call while Jev answers; shadow judges after it ran.
      hookMs: mode === 'active' ? hookMs + result.ms : hookMs,
      decision: verdict === undefined ? 'allow' : verdict.risk >= settings.toolThreshold ? (mode === 'active' ? 'deny' : 'would-deny') : 'allow',
      facts: { tool: facts.tool, kind: 'jev', class: verdict?.choice ?? '-', trust: trust.trust, why: trust.why },
    })
    showStatus($)

    return verdict
  }

  if (mode === 'shadow') {
    const result = await next(e)
    void verdictOf().catch(() => undefined)

    return result
  }
  const verdict = await verdictOf()
  if (verdict !== undefined && verdict.risk >= settings.toolThreshold) {
    return {
      deny:
        `jev-harness: Jev judged ${sent.target} as ${verdict.choice} data (${verdict.risk.toFixed(2)}), and this session is ` +
        `served by a provider other than Anthropic (${trust.why}). Do it from a first-party session instead.`,
    }
  }

  return next(e)
}

const keyFor = async ($: EngineInterface): Promise<{ key: string; source: string } | undefined> => {
  if (runtime.key === undefined) runtime.key = (await resolveKey($, settingsOf().apiKey)) ?? null

  return runtime.key ?? undefined
}

const trustFor = async ($: EngineInterface): Promise<{ trust: Trust; why: string }> => {
  const settings = settingsOf()
  if (runtime.trust === undefined) runtime.trust = await resolveTrust($, settings.providerTrust, settings.trustedProxies)

  return runtime.trust
}

const showStatus = ($: EngineInterface): void => {
  const settings = settingsOf()
  const { counts } = runtime
  const usesJev = settings.stopGate !== 'off' || settings.toolJev !== 'off' || settings.instructions !== 'off' || settings.foldJev !== 'off'
  if (!usesJev && settings.toolGate === 'off') return
  if (usesJev && runtime.key === null) return $.ui.status('jev: no key')
  const parts = ['jev']
  if (settings.stopGate !== 'off') parts.push(`stop ${settings.stopGate} ${counts.judged} judged${counts.failed ? `, ${counts.failed} failed` : ''}`)
  if (settings.toolGate !== 'off') parts.push(`tool ${settings.toolGate} ${counts.floor} hits`)
  if (settings.toolJev !== 'off') parts.push(`tool jev ${settings.toolJev} ${counts.toolJudged} judged`)
  if (settings.instructions !== 'off') {
    const f = runtime.fragments
    parts.push(`instr ${settings.instructions} ${f ? `${f.list.length} #${f.hash.slice(0, 6)}` : '-'}, ${counts.attached} attached`)
  }
  if (settings.foldJev !== 'off') parts.push(`fold ${settings.foldJev} ${counts.foldJudged} judged${counts.foldMissed ? `, ${counts.foldMissed} compactions unseen` : ''}`)
  $.ui.status(parts.join(' · '))
}

const fragmentsDirOf = async ($: EngineInterface): Promise<string> => {
  const dir = settingsOf().fragmentsDir.trim()
  if (dir === '~' || dir.startsWith('~/')) return `${await homeOf($)}${dir.slice(1)}`

  return dir
}

/** Reads the fragment folder once; a changed set of fragments is announced. */
const loadFragments = async ($: EngineInterface): Promise<{ list: Fragment[]; hash: string; dir: string; problems: string[] }> => {
  if (runtime.fragments !== undefined) return runtime.fragments
  const dir = await fragmentsDirOf($)
  const list: Fragment[] = []
  const problems: string[] = []
  if (dir !== '' && (await $.fs.exists(dir))) {
    const files = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md')).map(entry => entry.name).sort()
    for (const file of files) {
      if (list.length >= MAX_FRAGMENTS) {
        problems.push(`${file}: over ${MAX_FRAGMENTS} fragments`)
        continue
      }
      const parsed = parseFragment(file, await $.fs.read(`${dir}/${file}`))
      if (isFragment(parsed)) list.push(parsed)
      else problems.push(`${parsed.file}: ${parsed.reason}`)
    }
  }
  const hash = fragmentsHash(list)
  const seen = await $.store.get('fragments-hash')
  if (seen !== undefined && seen !== hash) $.ui.toast(`jev-harness: instruction fragments changed (#${hash.slice(0, 6)}, ${list.length} in ${dir})`)
  await $.store.set('fragments-hash', hash)
  runtime.fragments = { list, hash, dir, problems }

  return runtime.fragments
}

const namesIn = async ($: EngineInterface, key: string): Promise<Set<string>> => {
  const value = await $.store.get(key)

  return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
}

/** What a fragment decision is recorded as, one record per fragment. */
const recordFragments = async (
  $: EngineInterface,
  base: { sessionId: string; joinKey?: string; mode: 'shadow' | 'active'; t0: number; hookMs: number },
  decisions: readonly { name: string; rule: boolean; jev?: number; attach: boolean }[],
  sent: Record<string, unknown> | null,
  result: JevResult | undefined,
): Promise<void> => {
  for (const decision of decisions) {
    await writeRecord($, {
      id: newId(base.t0),
      ts: new Date(base.t0).toISOString(),
      sessionId: base.sessionId,
      joinKey: base.joinKey,
      point: INSTRUCTIONS_POINT,
      mode: base.mode,
      heuristic: decision.rule,
      sent,
      jev: decision.jev,
      usage: result?.ok ? result.usage : undefined,
      error: result === undefined || result.ok ? undefined : result.kind === 'http' ? `http ${result.status ?? 0}` : result.kind,
      jevMs: result?.ms,
      hookMs: base.hookMs,
      decision: decision.attach ? (base.mode === 'active' ? 'attach' : 'would-attach') : 'skip',
      facts: { fragment: decision.name },
    })
  }
}

/** Jev's probability that each candidate's condition holds for the prompt, keyed by fragment name. */
const askConditions = async (
  $: EngineInterface,
  sessionId: string,
  key: string,
  sent: Record<string, unknown>,
  candidates: readonly Fragment[],
): Promise<{ result?: JevResult; probabilities: Map<string, number> }> => {
  const probabilities = new Map<string, number>()
  if (candidates.length === 0) return { probabilities }
  const settings = settingsOf()
  const questions = Object.fromEntries(candidates.map(fragment => [fragment.name, conditionQuestion(fragment.when)]))
  const result = await judge($, { sessionId, point: INSTRUCTIONS_POINT, cap: settings.instructionCap }, key, sent, questions, settings.timeoutMs)
  if (result.ok) {
    for (const fragment of candidates) {
      const answer = result.answers[fragment.name]
      const p = answer === undefined ? undefined : probabilityOf(answer, 'applies')
      if (p !== undefined) probabilities.set(fragment.name, p)
    }
  }

  return { result, probabilities }
}

/** Forget which fragments were appended: after a compaction they are gone with the old turns. */
const forgetFragments = async ($: EngineInterface): Promise<void> => {
  const sessionId = await $.session.id()
  await $.store.set(`attached:${sessionId}`, [])
  await $.store.set(`would-attach:${sessionId}`, [])
}

/** Shadow judgment of fold relevance over the transcript as it stood before compaction. */
const judgeFold = async ($: EngineInterface, messages: readonly SessionMessage[]): Promise<void> => {
  const settings = settingsOf()
  const key = await keyFor($)
  const request = currentRequest(messages)
  if (key === undefined || request === undefined) return
  const home = await homeOf($)
  const cwd = await $.session.cwd()
  const sessionId = await $.session.id()
  const candidates = foldCandidates(messages, home, cwd, 48)
  const sent = { current_request: scrub(request, home).slice(0, 400) }
  for (let start = 0; start < candidates.length; start += 24) {
    const batch = candidates.slice(start, start + 24)
    const t0 = await $.clock.now()
    const questions = Object.fromEntries(batch.map((candidate, i) => [`r${i}`, foldQuestion(scrub(candidate.call, home))]))
    const result = await judge($, { sessionId, point: FOLD_POINT, cap: settings.foldCap }, key.key, sent, questions, settings.timeoutMs * 2)
    for (const [i, candidate] of batch.entries()) {
      const answer = result.ok ? result.answers[`r${i}`] : undefined
      const needed = answer === undefined ? undefined : probabilityOf(answer, 'needed')
      if (needed !== undefined) runtime.counts.foldJudged++
      await writeRecord($, {
        id: newId(t0),
        ts: new Date(t0).toISOString(),
        sessionId,
        joinKey: candidate.id,
        point: FOLD_POINT,
        mode: 'shadow',
        // Positive means "fold": the rule's verdict, and Jev's probability that the output is done with.
        heuristic: candidate.ruleFolds,
        sent: { ...sent, call: scrub(candidate.call, home) },
        jev: needed === undefined ? undefined : 1 - needed,
        usage: result.ok && i === 0 ? result.usage : undefined,
        error: result.ok ? undefined : result.kind === 'http' ? `http ${result.status ?? 0}` : result.kind,
        jevMs: result.ms,
        hookMs: 0,
        facts: { tool: candidate.tool, chars: String(candidate.chars), turnsAgo: String(candidate.turnsAgo) },
      })
    }
  }
  showStatus($)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    stopGate: modeOf(options.stopGate),
    toolGate: modeOf(options.toolGate),
    stopThreshold: numberOf(options.stopThreshold, 0.7, 0, 1),
    timeoutMs: numberOf(options.timeoutMs, 2000, 200, 8000),
    stopCap: numberOf(options.stopCap, 200, 0, 10_000),
    toolJev: modeOf(options.toolJev),
    toolThreshold: numberOf(options.toolThreshold, 0.8, 0, 1),
    toolCap: numberOf(options.toolCap, 300, 0, 10_000),
    providerTrust: options.providerTrust === 'external' ? 'external' : 'auto',
    trustedProxies:
      typeof options.trustedProxies === 'string'
        ? options.trustedProxies.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [],
    apiKey: options.apiKey,
    instructions: modeOf(options.instructions),
    fragmentsDir: typeof options.fragmentsDir === 'string' && options.fragmentsDir.trim() !== '' ? options.fragmentsDir : '~/.agents/fragments',
    instructionThreshold: numberOf(options.instructionThreshold, 0.95, 0, 1),
    instructionCap: numberOf(options.instructionCap, 200, 0, 10_000),
    foldJev: options.foldJev === 'shadow' ? 'shadow' : 'off',
    foldCap: numberOf(options.foldCap, 20, 0, 1000),
  }
  runtime.settings = settings
  runtime.key = undefined
  runtime.trust = undefined
  runtime.fragments = undefined
  const isOn =
    settings.stopGate !== 'off' || settings.toolGate !== 'off' || settings.toolJev !== 'off' || settings.instructions !== 'off' || settings.foldJev !== 'off'
  const { counts } = runtime

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jev-report', description: 'jev-harness: what the gates recorded and how Jev agreed with the rules' })
    await $.command.register({ name: 'jev-mark', description: 'jev-harness: label a record, /jev-mark <id> y|n', argumentHint: '<id> y|n' })
    const root = await logRootOf($)
    if (await $.fs.exists(root)) {
      // Records older than 14 days go; labels stay.
      await $.process.run(['find', root, '-type', 'f', '-mtime', '+14', '-not', '-path', `${root}/labels/*`, '-delete'])
      await $.process.run(['find', root, '-mindepth', '1', '-type', 'd', '-empty', '-delete'])
    }
    if (settings.instructions !== 'off') await loadFragments($)
    if (isOn) {
      await keyFor($)
      showStatus($)
    }

    return next(e)
  })

  // E1, pinned fragments: one stable section at the end of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (settings.instructions !== 'active') return composed
    const text = pinnedSection((await loadFragments($)).list)
    if (text === undefined) return composed

    return { ...composed, sections: [...composed.sections, { id: 'jev-harness:pinned', text, scope: 'session' as const }] }
  }).catch((_, e, next) => next(e))

  // E1, conditional fragments: appended to the prompt that first meets their
  // condition, once; judged again only after a compaction.
  on('prompt.submit', async ($, e, next) => {
    const mode = settings.instructions
    // The person's own prompts only: typed, remote, headless, or a plugin's sent as the person's words.
    const origin = e.origin
    const isPersons =
      origin !== undefined &&
      (origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk' || (origin.kind === 'plugin' && origin.asUser === true))
    if (mode === 'off' || e.command !== undefined || e.isMeta || !isPersons) return next(e)
    const t0 = await $.clock.now()
    const { list } = await loadFragments($)
    const sessionId = await $.session.id()
    const storeKey = `${mode === 'active' ? 'attached' : 'would-attach'}:${sessionId}`
    const done = await namesIn($, storeKey)
    const candidates = list.filter(fragment => !fragment.pin && !done.has(fragment.name))
    if (candidates.length === 0) return next(e)

    const rule = new Map(candidates.map(fragment => [fragment.name, keywordHit(e.text, fragment.keywords)]))
    const key = await keyFor($)
    const sent = key === undefined ? null : { request: scrub(e.text, await homeOf($)).slice(0, 600) }
    // Active asks Jev only where no keyword decided; shadow asks for every candidate, to compare.
    const toAsk = mode === 'active' ? candidates.filter(fragment => rule.get(fragment.name) !== true) : candidates

    const finish = async (asked: { result?: JevResult; probabilities: Map<string, number> }, hookMs: number) => {
      const decisions = decideFragments(candidates, rule, asked.probabilities, settings.instructionThreshold)
      const chosen = decisions.filter(d => d.attach).map(d => d.name)
      if (chosen.length > 0) await $.store.set(storeKey, [...done, ...chosen])
      runtime.counts.attached += chosen.length
      await recordFragments($, { sessionId, joinKey: e.turnId, mode, t0, hookMs }, decisions, sent, asked.result)
      showStatus($)

      return chosen
    }

    if (mode === 'shadow') {
      const result = await next(e)
      const hookMs = (await $.clock.now()) - t0
      void (async () => finish(key && sent ? await askConditions($, sessionId, key.key, sent, toAsk) : { probabilities: new Map() }, hookMs))().catch(() => undefined)

      return result
    }
    const asked = key && sent ? await askConditions($, sessionId, key.key, sent, toAsk) : { probabilities: new Map<string, number>() }
    const chosen = await finish(asked, (await $.clock.now()) - t0)
    const blocks = list.filter(fragment => chosen.includes(fragment.name)).map(fragmentBlock)

    return blocks.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch((_, e, next) => next(e))

  // After a compaction the appended fragments are gone with the old turns:
  // every fragment may be judged again.
  on('classic.PostCompact', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined) return below
    if (settings.instructions !== 'off') await forgetFragments($)
    // A plugin loaded before this one answered the compaction, so its transcript was never seen.
    if (settings.foldJev !== 'off' && runtime.sawCompaction !== true) {
      runtime.counts.foldMissed++
      $.ui.log(`${$.plugin.name}: a compaction was answered before this plugin saw it; load jev-harness before plugins that compact (context-fold) to judge fold relevance`)
      showStatus($)
    }
    runtime.sawCompaction = false

    return below
  }).catch((_, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
    if (settings.instructions !== 'off' && (e.source === 'compact' || e.source === 'clear')) await forgetFragments($)

    return below
  }).catch((_, e, next) => next(e))

  // Fold relevance, shadow: the transcript as it stands before the compaction.
  // classic.PreCompact runs only when the engine itself summarizes, so a
  // compaction another plugin answers (context-fold) would go unseen there.
  on('session.compact', async ($, e, next) => {
    if (settings.foldJev !== 'off' && e.agentId === undefined && e.trigger !== 'precompute') {
      runtime.sawCompaction = true
      void judgeFold($, e.messages).catch(() => undefined)
    }

    return next(e)
  }).catch((_, e, next) => next(e))

  on('command.run', { command: 'jev-report' }, async $ => {
    const { records, labels } = await readRecords($, 20_000)
    const key = await keyFor($)
    const trust = await trustFor($)
    const fragments = settings.instructions === 'off' ? undefined : await loadFragments($)
    const header = [
      `jev-harness: stop ${settings.stopGate}, tool ${settings.toolGate}, tool jev ${settings.toolJev}, instructions ${settings.instructions}, fold ${settings.foldJev}`,
      `key ${key ? `from ${key.source}` : 'none'}, provider ${trust.trust} (${trust.why})`,
      ...(fragments
        ? [`fragments: ${fragments.list.length} in ${fragments.dir} (#${fragments.hash.slice(0, 6)})${fragments.problems.length ? `; skipped: ${fragments.problems.join('; ')}` : ''}`]
        : []),
      `${records.length} records, ${labels.size} labels`,
    ]
    const reports = [
      pointReport(STOP_POINT, records, labels, settings.stopThreshold),
      pointReport(TOOL_POINT, records, labels, settings.toolThreshold),
      pointReport(INSTRUCTIONS_POINT, records, labels, settings.instructionThreshold),
      pointReport(FOLD_POINT, records, labels, 0.5),
    ]

    return { text: [...header, ...reports].join('\n\n') }
  })

  on('command.run', { command: 'jev-mark' }, async ($, e) => {
    const [id, value] = e.args.trim().split(/\s+/)
    if (id === undefined || !/^[a-z0-9]{4,20}$/.test(id) || (value !== 'y' && value !== 'n')) return { text: 'Usage: /jev-mark <id> y|n' }
    const root = await logRootOf($)
    await $.process.run(['mkdir', '-p', root])
    await $.process.run(['chmod', '700', root])
    await $.fs.write(`${root}/labels/labels/${id}.json`, JSON.stringify({ id, label: value === 'y', ts: new Date(await $.clock.now()).toISOString() }))

    return { text: `Labeled ${id} as ${value === 'y' ? 'positive' : 'negative'}.` }
  })

  // E5: a turn that ends by announcing work. Settings Stop hooks run first.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    const mode = settings.stopGate
    if (mode === 'off' || below.block !== undefined) return below

    const t0 = await $.clock.now()
    const paragraph = lastParagraph(e.last_assistant_message)
    const skipped = stopSkipReason({
      stopHookActive: e.stop_hook_active,
      permissionMode: e.permission_mode,
      backgroundTasks: e.background_tasks?.length ?? 0,
      scheduledTasks: e.session_crons?.length ?? 0,
      agentId: e.agent_id,
      paragraph,
    })
    const base = { id: newId(t0), ts: new Date(t0).toISOString(), sessionId: e.session_id, joinKey: e.prompt_id, point: STOP_POINT, mode }
    if (skipped !== undefined) {
      void writeRecord($, { ...base, skipped, sent: null, hookMs: (await $.clock.now()) - t0 }).catch(() => undefined)

      return below
    }

    const heuristic = announcesByRule(paragraph)
    const key = await keyFor($)
    if (key === undefined) {
      void writeRecord($, { ...base, heuristic, sent: null, error: 'no-key', hookMs: (await $.clock.now()) - t0 }).catch(() => undefined)
      showStatus($)

      return below
    }

    const sent = { last_paragraph: scrub(paragraph, await homeOf($)) }
    const run = async (hookMs: number): Promise<number | undefined> => {
      const result = await judge($, { sessionId: e.session_id, point: STOP_POINT, cap: settings.stopCap }, key.key, sent, { stop: STOP_QUESTION }, settings.timeoutMs)
      const probability = result.ok ? probabilityOf(result.answers.stop!, 'announce') : undefined
      const isFlagged = probability !== undefined && probability >= settings.stopThreshold
      if (result.ok) counts.judged++
      else counts.failed++
      await writeRecord($, {
        ...base,
        heuristic,
        sent,
        jev: probability,
        usage: result.ok ? result.usage : undefined,
        error: result.ok ? undefined : result.kind === 'http' ? `http ${result.status ?? 0}` : result.kind,
        jevMs: result.ms,
        hookMs,
        decision: isFlagged ? (mode === 'active' ? 'continue' : 'would-continue') : 'stop',
      })
      showStatus($)

      return probability
    }

    if (mode === 'shadow') {
      // Judged after the hook returns: the turn ends without waiting for Jev.
      const hookMs = (await $.clock.now()) - t0
      void run(hookMs).catch(() => undefined)

      return below
    }
    const probability = await run((await $.clock.now()) - t0)

    return probability !== undefined && probability >= settings.stopThreshold ? { ...below, block: STOP_MESSAGE } : below
  }).catch((_, e, next) => next(e))

  // E2: the floor (restricted paths and secret-printing commands, no Jev)
  // and, for what it lets through in an external session, Jev's judgment.
  on('tool.call', async ($, e, next) => {
    const mode = settings.toolGate
    const jevMode = settings.toolJev
    if (mode === 'off' && jevMode === 'off') return next(e)

    const t0 = await $.clock.now()
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
    const home = await homeOf($)
    const cwd = await $.session.cwd()
    const candidates = [...new Set([...pathFieldValues(input), ...(command === undefined ? [] : pathCandidates(command))])].slice(0, 40)
    const protectedRoots = [$.plugin.root, await logRootOf($), ...(settings.instructions === 'off' ? [] : [await fragmentsDirOf($)])]
    const isWriting = canWrite(tool, command)

    let verdict: FloorVerdict | undefined
    for (const candidate of candidates) {
      const lexical = normalizePath(candidate, home, cwd)
      let real = lexical
      try {
        real = (await $.fs.stat(lexical, { resolve: true })).realPath ?? lexical
      } catch {
        // A path that does not exist yet is judged by its spelling.
      }
      for (const path of new Set([lexical, real])) {
        const self = isWriting ? selfProtectReason(path, protectedRoots) : undefined
        const restricted = restrictedReason(path, home)
        // A link names both what was asked for and what it leads to.
        const shown = (path === lexical ? lexical : `${lexical} -> ${real}`).split(home).join('~')
        if (self !== undefined) verdict = { kind: 'self', reason: self, path: shown }
        else if (restricted !== undefined) verdict ??= { kind: 'restricted', reason: restricted, path: shown }
      }
      if (verdict?.kind === 'self') break
    }
    const dump = command === undefined ? undefined : secretDumpReason(command)
    if (verdict === undefined && dump !== undefined) verdict = { kind: 'secret-dump', reason: dump }
    // A call the floor names never goes to Jev, whatever the floor's own mode.
    if (verdict === undefined) return judgeTool($, e, next, { tool, command, candidates, home, cwd, t0 })
    if (mode === 'off') return next(e)

    const trust = await trustFor($)
    const isRefused = verdict.kind === 'self' || trust.trust === 'external'
    counts.floor++
    const record: ShadowRecord = {
      id: newId(t0),
      ts: new Date(t0).toISOString(),
      sessionId: await $.session.id(),
      joinKey: e.tool_use_id,
      point: TOOL_POINT,
      mode,
      sent: null,
      hookMs: (await $.clock.now()) - t0,
      decision: isRefused ? (mode === 'active' ? 'deny' : 'would-deny') : 'allow',
      facts: { tool, kind: verdict.kind, reason: verdict.reason, trust: trust.trust, why: trust.why },
    }
    void writeRecord($, record).catch(() => undefined)
    showStatus($)
    if (mode === 'active' && isRefused) return { deny: denyMessage(verdict, trust.trust) }

    return next(e)
  }).catch(($, e, next) =>
    // The floor fails closed when active: a guard that broke refuses rather than lets through.
    next.called || settings.toolGate !== 'active' ? next(e) : { deny: 'jev-harness: the tool guard failed, so this call was refused.' },
  )
}
