import type { HttpResponse } from 'claude-code'
import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
// The test runtime has timers; the type library the mod is checked with does not declare them.
declare const setTimeout: (callback: () => void, ms: number) => unknown
import { STOP_MESSAGE } from '../hooks/stop-gate'

type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  fetch?: (body: Record<string, unknown>) => HttpResponse | Promise<HttpResponse>
  isAuthorized?: boolean
  realPaths?: Record<string, string>
  cwdFails?: boolean
  /** A timer that never fires, so only the Jev answer can settle the race. */
  isTimerStopped?: boolean
  /** What the settings Stop hooks beneath the plugin answer. */
  stopBelow?: { block?: string }
}

const HOME = '/home/me'
const ANNOUNCE = (p: number): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: { stop: { type: 'choice', choice: p >= 0.5 ? 'announce' : 'report', confidence: 0.98, probabilities: { announce: p, report: 1 - p } } },
    usage: { input_tokens: 373, output_tokens: 31 },
  }),
})

const setup = (on: On, s: Setup = {}) => {
  const env: Record<string, string> = { HOME, ...s.env }
  const files: Record<string, string> = { ...s.files }
  const fetches: { headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const writes: { path: string; text: string }[] = []
  const store = new Map<string, unknown>()
  const statuses: (string | undefined)[] = []
  let now = 1_700_000_000_000

  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.exists', (_, e) => ({ value: e.path in files || writes.some(w => w.path.startsWith(`${e.path}/`)) }))
  on('fs.read', (_, e) => {
    const written = writes.find(w => w.path === e.path)
    if (written) return { value: written.text }
    return e.path in files ? { value: files[e.path]! } : { deny: 'missing' }
  })
  on('fs.list', (_, e) => {
    const prefix = `${e.path}/`
    const names = new Set(writes.filter(w => w.path.startsWith(prefix)).map(w => w.path.slice(prefix.length).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: name.endsWith('.json') ? ('file' as const) : ('dir' as const), size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const real = s.realPaths?.[e.path]
    return real === undefined ? { deny: 'missing' } : { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: real } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.now', () => ({ value: (now += 5) }))
  on('clock.sleep', () => (s.isTimerStopped ? new Promise<never>(() => undefined) : { value: undefined }))
  on('http.fetch', async (_, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    fetches.push({ headers: { ...e.init?.headers }, body })
    return { value: await (s.fetch ?? (() => ANNOUNCE(0.99)))(body) }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: s.isAuthorized === false ? null : { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => (s.cwdFails ? { deny: 'no cwd' } : { value: '/proj' }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The settings hooks and the tool beneath the plugin.
  on('classic.Stop', () => s.stopBelow ?? {})
  on('tool.call', () => ({ result: 'ok' }))

  return { fetches, writes, store, statuses }
}

const records = (writes: readonly { path: string; text: string }[], point: string) =>
  writes.filter(w => w.path.includes(`/${point}/`)).map(w => JSON.parse(w.text) as Record<string, unknown>)

const settle = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 1))
}

const STOP = { stop_hook_active: false, last_assistant_message: '파서를 고쳤습니다.\n\n문의는 a@b.co 로 받습니다. 이어서 캐시를 리팩터링하겠습니다.' }
const KEY_ENV = { TYPESAFE_API_KEY: 'tk-env' }

test('off by default: a key alone sends nothing', async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  const result = await $.classic.Stop(STOP)
  await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })

  expect(result.block).toBe(undefined)
  expect(io.fetches.length).toBe(0)
  expect(io.writes.length).toBe(0)
})

test('shadow: the turn ends at once and the judgment is recorded afterwards, scrubbed', { options: { stopGate: 'shadow' } }, async ($, on) => {
  let release: (r: HttpResponse) => void = () => undefined
  const io = setup(on, { env: KEY_ENV, isTimerStopped: true, fetch: () => new Promise<HttpResponse>(resolve => (release = resolve)) })

  const started = Date.now()
  const result = await $.classic.Stop(STOP)
  expect(Date.now() - started < 1000).toBe(true)
  expect(result.block).toBe(undefined)
  expect(io.writes.length).toBe(0)

  // The judgment runs after the hook returned; answer it once it has asked.
  await settle(() => io.fetches.length > 0)
  release(ANNOUNCE(0.99))
  await settle(() => records(io.writes, 'stop').length > 0)
  const [record] = records(io.writes, 'stop')
  expect(record?.decision).toBe('would-continue')
  expect(record?.heuristic).toBe(true)
  expect(record?.jev).toBe(0.99)
  expect(JSON.stringify(record?.sent)).not.toContain('a@b.co')
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer tk-env')
})

test('active: an announcing turn is sent back to work; a report ends', { options: { stopGate: 'active' } }, async ($, on) => {
  let p = 0.99
  setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE(p) })
  expect((await $.classic.Stop(STOP)).block).toBe(STOP_MESSAGE)
  p = 0.01
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
})

test('active: a Jev call that does not answer in time changes nothing', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => new Promise<HttpResponse>(() => undefined) })
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(records(io.writes, 'stop')[0]?.error).toBe('timeout')
})

test('a block from the settings Stop hooks beneath wins, and Jev is not asked', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, stopBelow: { block: 'budget guard' } })
  expect((await $.classic.Stop(STOP)).block).toBe('budget guard')
  expect(io.fetches.length).toBe(0)
})

test('plan mode, background work and re-entry are not judged', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.classic.Stop({ ...STOP, stop_hook_active: true })
  await $.classic.Stop({ ...STOP, permission_mode: 'plan' })
  await $.classic.Stop({ ...STOP, background_tasks: [{ id: 't', type: 'bash', status: 'running', description: 'x' }] as never })
  await settle(() => records(io.writes, 'stop').length >= 3)
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'stop').map(r => r.skipped)).toEqual(['stop-hook-active', 'plan-mode', 'background-tasks'])
})

test('without a key nothing is sent and the status says so', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.classic.Stop(STOP)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'stop')[0]?.error).toBe('no-key')
  expect(io.statuses).toContain('jev: no key')
})

test('the sensitive setting outranks the plugin .env, which outranks the environment', { options: { stopGate: 'active', apiKey: 'tk-config' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer tk-config')
})

test('the call cap and the circuit stop sending', { options: { stopGate: 'active', stopCap: 1 } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.classic.Stop(STOP)
  await $.classic.Stop(STOP)
  expect(io.fetches.length).toBe(1)
  await settle(() => records(io.writes, 'stop').length >= 2)
  expect(records(io.writes, 'stop')[1]?.error).toBe('cap')
})

test('three failed calls open the circuit', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  for (let i = 0; i < 4; i++) await $.classic.Stop(STOP)
  expect(io.fetches.length).toBe(3)
})

test('tool gate, external provider: secret files and secret-printing commands are refused', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toContain('env file')
  expect((await $.tool.call({ tool: 'Read', file_path: '~/.oh-my-zsh/custom/apikey.env' })).deny).toContain('env file')
  expect((await $.tool.call({ tool: 'Bash', command: 'git diff --no-index /dev/null .ENV' })).deny).toContain('env file')
  expect((await $.tool.call({ tool: 'Bash', command: 'printenv | sort' })).deny).toContain('printenv')
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).deny).toBe(undefined)
  expect(io.fetches.length).toBe(0)
})

test('tool gate follows symlinks to what they name', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on, { realPaths: { '/proj/notes.txt': `${HOME}/.ssh/id_rsa` } })
  const denied = (await $.tool.call({ tool: 'Read', file_path: 'notes.txt' })).deny
  expect(denied).toContain('ssh')
  expect(denied).toContain('/proj/notes.txt -> ~/.ssh/id_rsa')
})

test('tool gate, first-party session: secret files pass and are recorded', { options: { toolGate: 'active' } }, async ($, on) => {
  const io = setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toBe(undefined)
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('allow')
})

test('tool gate shadow only records what it would refuse', { options: { toolGate: 'shadow', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toBe(undefined)
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('would-deny')
})

test('the agent may not rewrite the plugin or the Claude settings, even first-party', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Write', file_path: `${HOME}/.claude-3/settings.json`, content: '{}' })).deny).toContain('claude settings')
  expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${HOME}/.local/state/jev-harness/a.json` })).deny).toContain('jev-harness files')
})

test('an active tool guard that breaks refuses the call', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on, { cwdFails: true })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/a.txt' })).deny).toContain('guard failed')
})

test('a shadow tool guard that breaks lets the call through', { options: { toolGate: 'shadow' } }, async ($, on) => {
  setup(on, { cwdFails: true })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/a.txt' })).deny).toBe(undefined)
})

test('/jev-mark writes a label and /jev-report reads records and labels', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  const root = `${HOME}/.local/state/jev-harness`
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.classic.Stop(STOP)
  await settle(() => records(io.writes, 'stop').length > 0)
  const id = String(records(io.writes, 'stop')[0]?.id)

  expect((await $.command.run({ command: 'jev-mark', args: `${id} y` } as never)).text).toContain('positive')
  expect(io.writes.some(w => w.path === `${root}/labels/labels/${id}.json`)).toBe(true)
  const report = (await $.command.run({ command: 'jev-report', args: '' } as never)).text ?? ''
  expect(report).toContain('1 records, 1 labels')
  expect(report).toContain('labels 1 (positive 1, negative 0)')
  expect((await $.command.run({ command: 'jev-mark', args: 'bad' } as never)).text).toContain('Usage')
})
