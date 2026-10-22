import type { Args, EngineInterface, EventResult, Next, Register } from 'claude-code'
import { admit, afterCall, readBudget } from './budget'
import { JEV_ENDPOINT, parseResponse, probabilityOf, requestBody, type JevQuestion, type JevResult } from './jev'
import { pickKey } from './key'
import { pointReport, type ShadowRecord } from './report'
import { scrub } from './scrub'
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
}

// Per process: reset on a reload, which only costs a mkdir and a lookup.
const madeDirs = new Set<string>()
let sequence = 0
const runtime: {
  settings?: Settings
  counts: { judged: number; failed: number; floor: number; toolJudged: number }
  key?: { key: string; source: string } | null
  trust?: { trust: Trust; why: string }
} = { counts: { judged: 0, failed: 0, floor: 0, toolJudged: 0 } }

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
  if (settings.stopGate === 'off' && settings.toolGate === 'off' && settings.toolJev === 'off') return
  if ((settings.stopGate !== 'off' || settings.toolJev !== 'off') && runtime.key === null) return $.ui.status('jev: no key')
  const parts = ['jev']
  if (settings.stopGate !== 'off') parts.push(`stop ${settings.stopGate} ${counts.judged} judged${counts.failed ? `, ${counts.failed} failed` : ''}`)
  if (settings.toolGate !== 'off') parts.push(`tool ${settings.toolGate} ${counts.floor} hits`)
  if (settings.toolJev !== 'off') parts.push(`tool jev ${settings.toolJev} ${counts.toolJudged} judged`)
  $.ui.status(parts.join(' · '))
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
  }
  runtime.settings = settings
  runtime.key = undefined
  runtime.trust = undefined
  const isOn = settings.stopGate !== 'off' || settings.toolGate !== 'off' || settings.toolJev !== 'off'
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
    if (isOn) {
      await keyFor($)
      showStatus($)
    }

    return next(e)
  })

  on('command.run', { command: 'jev-report' }, async $ => {
    const { records, labels } = await readRecords($, 20_000)
    const key = await keyFor($)
    const trust = await trustFor($)
    const header = [
      `jev-harness: stop ${settings.stopGate}, tool ${settings.toolGate}, key ${key ? `from ${key.source}` : 'none'}, provider ${trust.trust} (${trust.why})`,
      `${records.length} records, ${labels.size} labels`,
    ]

    return { text: [...header, pointReport(STOP_POINT, records, labels, settings.stopThreshold), pointReport(TOOL_POINT, records, labels, 0.5)].join('\n\n') }
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
    const protectedRoots = [$.plugin.root, await logRootOf($)]
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
