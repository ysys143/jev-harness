import type { HttpResponse, SessionMessage } from 'claude-code'
import { expect, test, type TestBody } from 'claude-code/testing'
import { currentRequest, foldCandidates, ruleWouldFold, turnsAgoOf } from '../hooks/fold-judge'
import { decideFragments, fragmentBlock, fragmentsHash, isFragment, keywordHit, parseFragment, pinnedSection, type Fragment } from '../hooks/instructions'

type On = Parameters<TestBody>[1]
// The test runtime has timers; the type library the mod is checked with does not declare them.
declare const setTimeout: (callback: () => void, ms: number) => unknown

const HOME = '/home/me'
const DIR = `${HOME}/.agents/fragments`

const PROSE = `---\nwhen: The person asks for prose meant for human readers.\nkeywords: 보고서, report\n---\nWrite plainly; no filler.\n`
const DEPLOY = `---\nwhen: The work involves deploying or releasing.\n---\nCheck the rollback plan first.\n`
const ALWAYS = `---\npin: true\n---\nAnswer in the person's language.\n`

test('a fragment file needs frontmatter, a body, and a condition unless pinned', () => {
  const prose = parseFragment('prose.md', PROSE)
  expect(isFragment(prose)).toBe(true)
  if (isFragment(prose)) {
    expect(prose).toEqual({ name: 'prose', when: 'The person asks for prose meant for human readers.', keywords: ['보고서', 'report'], pin: false, body: 'Write plainly; no filler.' })
  }
  expect(isFragment(parseFragment('always.md', ALWAYS))).toBe(true)
  expect(parseFragment('x.md', 'no frontmatter')).toEqual({ file: 'x.md', reason: 'no frontmatter' })
  expect(parseFragment('x.md', '---\nwhen: a\n---\n')).toEqual({ file: 'x.md', reason: 'empty body' })
  expect(parseFragment('x.md', '---\nkeywords: a\n---\nbody')).toEqual({ file: 'x.md', reason: 'no when: (or pin: true)' })
  expect(parseFragment('x.md', `---\nwhen: a\n---\n${'y'.repeat(5000)}`)).toEqual({ file: 'x.md', reason: 'body over 4096 characters' })
  expect(parseFragment('bad name.md', PROSE)).toEqual({ file: 'bad name.md', reason: 'name must be letters, digits, - or _' })
})

test('keywords match whole words in Latin text and substrings otherwise', () => {
  expect(keywordHit('Write the weekly report', ['report'])).toBe(true)
  expect(keywordHit('Fix the reporter module', ['report'])).toBe(false)
  expect(keywordHit('주간 보고서로 정리해줘', ['보고서'])).toBe(true)
  expect(keywordHit('Fix the bug', [])).toBe(false)
})

test('a keyword hit attaches without Jev; otherwise the threshold decides; no answer, no attach', () => {
  const fragments = [PROSE, DEPLOY].map((text, i) => parseFragment(`f${i}.md`, text)).filter(isFragment)
  const decisions = decideFragments(fragments, new Map([['f0', true], ['f1', false]]), new Map([['f1', 0.95]]), 0.9)
  expect(decisions.map(d => [d.name, d.attach])).toEqual([['f0', true], ['f1', true]])
  expect(decideFragments(fragments, new Map(), new Map([['f1', 0.78]]), 0.9).map(d => d.attach)).toEqual([false, false])
})

test('pinned fragments form one stable section; the hash follows any change', () => {
  const list = [ALWAYS, PROSE].map((text, i) => parseFragment(`p${i}.md`, text)).filter(isFragment)
  expect(pinnedSection(list)).toBe(fragmentBlock(list[0]!))
  expect(pinnedSection(list.slice(1))).toBe(undefined)
  expect(fragmentsHash(list)).toBe(fragmentsHash(list))
  expect(fragmentsHash(list)).not.toBe(fragmentsHash([list[0]!, { ...list[1]!, body: 'changed' } as Fragment]))
})

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string, isError = false): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] })
const BIG = 'x\n'.repeat(1500)

const TRANSCRIPT: SessionMessage[] = [
  prompt('Look at the billing code'),
  call('a', 'Read', { file_path: '/proj/src/billing/invoice.ts' }),
  answer('a', BIG),
  call('b', 'Bash', { command: 'ls -R /proj' }),
  answer('b', 'x'.repeat(800)),
  prompt('<system-reminder>not a prompt</system-reminder>'),
  prompt('Now check the tests'),
  call('c', 'Bash', { command: 'npm test' }),
  answer('c', `${BIG}${BIG}`),
  prompt('Fix the rounding bug in invoice totals'),
  call('d', 'Read', { file_path: '/proj/README.md' }),
  answer('d', '[folded Read · ./README.md · 60 lines]'),
  prompt('/compact'),
]

test('fold candidates: large, not yet folded, largest first, judged by the size-and-age rule', () => {
  expect(currentRequest(TRANSCRIPT)).toBe('Fix the rounding bug in invoice totals')
  expect(turnsAgoOf(TRANSCRIPT)[2]).toBe(2)
  // A /command is not the request.
  const candidates = foldCandidates(TRANSCRIPT, HOME, '/proj', 48)
  expect(candidates.map(c => [c.id, c.call, c.turnsAgo, c.ruleFolds])).toEqual([
    ['c', 'Bash npm test (3001 lines)', 1, false],
    ['a', 'Read ./src/billing/invoice.ts (1501 lines)', 2, true],
  ])
  expect(ruleWouldFold('TodoWrite', 5000, 5, false)).toBe(false)
  expect(ruleWouldFold('Bash', 1500, 5, true)).toBe(false)
  expect(ruleWouldFold('Bash', 2500, 5, true)).toBe(true)
})

const choice = (probabilities: Record<string, Record<string, number>>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(
      Object.entries(probabilities).map(([name, p]) => {
        const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0]
        return [name, { type: 'choice', choice: top, confidence: 0.9, probabilities: p }]
      }),
    ),
    usage: { input_tokens: 400, output_tokens: 40 },
  }),
})

type Setup = { files?: Record<string, string>; fetch?: (body: Record<string, unknown>) => HttpResponse | Promise<HttpResponse>; messages?: SessionMessage[] }

const setup = (on: On, s: Setup = {}) => {
  const env: Record<string, string> = { HOME, TYPESAFE_API_KEY: 'tk-env' }
  const files: Record<string, string> = { ...s.files }
  const writes: { path: string; text: string }[] = []
  const fetches: Record<string, unknown>[] = []
  const store = new Map<string, unknown>()
  const submitted: { text: string; context?: readonly string[] }[] = []
  const toasts: string[] = []
  const statuses: string[] = []
  let now = 1_700_000_000_000
  const under = (dir: string): string[] => [...Object.keys(files), ...writes.map(w => w.path)].filter(p => p.startsWith(`${dir}/`))

  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.exists', (_, e) => ({ value: e.path in files || under(e.path).length > 0 }))
  on('fs.list', (_, e) => {
    const names = new Set(under(e.path).map(p => p.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: under(`${e.path}/${name}`).length > 0 ? ('dir' as const) : ('file' as const), size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    const written = writes.find(w => w.path === e.path)
    if (written) return { value: written.text }
    return e.path in files ? { value: files[e.path]! } : { deny: 'missing' }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.now', () => ({ value: (now += 5) }))
  on('clock.sleep', () => ({ value: undefined }))
  on('http.fetch', async (_, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    fetches.push(body)
    return { value: await (s.fetch ?? (() => choice({})))(body) }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.messages', () => ({ value: s.messages ?? [] }))
  on('ui.status', (_, e) => {
    if (e.text !== undefined) statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'You are helpful.', scope: 'shared' as const }] }))
  on('session.compact', () => ({ messages: [prompt('summary')] }))
  on('classic.PostCompact', () => ({}))
  on('classic.SessionStart', () => ({}))

  return { writes, fetches, store, submitted, toasts, statuses }
}

const records = (writes: readonly { path: string; text: string }[], point: string) =>
  writes.filter(w => w.path.includes(`/${point}/`)).map(w => JSON.parse(w.text) as Record<string, unknown>)

const settle = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 1))
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] }

const FILES = { [`${DIR}/prose.md`]: PROSE, [`${DIR}/deploy.md`]: DEPLOY, [`${DIR}/always.md`]: ALWAYS }
const ACTIVE = { options: { instructions: 'active' } }

test('active: a fragment whose condition holds is appended to that prompt, once', ACTIVE, async ($, on) => {
  const io = setup(on, {
    files: FILES,
    fetch: body => choice(Object.fromEntries(Object.keys(body.questions as object).map(name => [name, name === 'deploy' ? { applies: 0.99, not: 0.01 } : { applies: 0.02, not: 0.98 }]))),
  })
  await $.prompt.submit(typed('Publish the release to npm'))
  expect(io.fetches.length).toBe(1)
  // Neither had a keyword hit, so both are asked about; only deploy applies.
  expect(Object.keys(io.fetches[0]!.questions as object).sort()).toEqual(['deploy', 'prose'])
  expect(io.submitted[0]?.context).toEqual(['<instruction name="deploy" source="jev-harness">\nCheck the rollback plan first.\n</instruction>'])

  await $.prompt.submit(typed('Publish the next release too'))
  expect(io.submitted[1]?.context).toBe(undefined)
  expect(Object.keys(io.fetches[1]!.questions as object)).toEqual(['prose'])
})

test('active: a keyword hit attaches without asking Jev about it', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: () => choice({ deploy: { applies: 0.01, not: 0.99 } }) })
  await $.prompt.submit(typed('주간 보고서로 정리해줘'))
  expect(Object.keys(io.fetches[0]!.questions as object)).toEqual(['deploy'])
  expect(io.submitted[0]?.context?.[0]).toContain('name="prose"')
})

test('after a compaction every fragment may be judged again', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: () => choice({ deploy: { applies: 0.99, not: 0.01 }, prose: { applies: 0.01, not: 0.99 } }) })
  await $.prompt.submit(typed('Publish the release'))
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' })
  await $.prompt.submit(typed('Publish it again'))
  expect(io.submitted[1]?.context?.[0]).toContain('name="deploy"')
})

test('shadow: the prompt goes on untouched and the judgment is recorded', { options: { instructions: 'shadow' } }, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: () => choice({ deploy: { applies: 0.99, not: 0.01 }, prose: { applies: 0.02, not: 0.98 } }) })
  await $.prompt.submit(typed('Publish the release, see a@b.co'))
  expect(io.submitted[0]?.context).toBe(undefined)
  await settle(() => records(io.writes, 'instructions').length >= 2)
  const byName = Object.fromEntries(records(io.writes, 'instructions').map(r => [(r.facts as Record<string, string>).fragment, r]))
  expect(byName.deploy?.decision).toBe('would-attach')
  expect(byName.prose?.decision).toBe('skip')
  expect(JSON.stringify(byName.deploy?.sent)).not.toContain('a@b.co')
})

test('slash commands and messages from other origins are left alone', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES })
  await $.prompt.submit({ text: 'A task from another plugin', wait: false, origin: { kind: 'plugin', name: 'other' } } as never)
  await $.prompt.submit({ ...typed('/deploy now'), command: { name: 'deploy', args: 'now' } } as never)
  expect(io.fetches.length).toBe(0)
})

test('pinned fragments become one section at the end of the system prompt, only when active', ACTIVE, async ($, on) => {
  setup(on, { files: FILES })
  const { sections } = await $.prompt.compose(COMPOSE as never)
  expect(sections.map(s => [s.id, s.scope])).toEqual([['base', 'shared'], ['jev-harness:pinned', 'session']])
  expect(sections[1]?.text).toContain("Answer in the person's language.")
})

test('a changed fragment set is announced', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES })
  io.store.set('fragments-hash', 'older')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(io.toasts[0]).toContain('instruction fragments changed')
})

test('fold shadow: at a compaction, large results are judged against the current request', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { fetch: () => choice({ r0: { needed: 0.9, done: 0.1 }, r1: { needed: 0.2, done: 0.8 } }) })
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  await settle(() => records(io.writes, 'fold').length >= 2)
  expect(io.fetches[0]?.state).toEqual({ current_request: 'Fix the rounding bug in invoice totals' })
  const rows = records(io.writes, 'fold').map(r => [r.joinKey, r.heuristic, Number(r.jev).toFixed(1)])
  expect(rows).toEqual([['c', false, '0.1'], ['a', true, '0.8']])
})

test('a compaction another plugin answered before this one is reported, not missed silently', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' })
  expect(io.statuses.at(-1)).toContain('1 compactions unseen')
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' })
  expect(io.statuses.at(-1)).toContain('1 compactions unseen')
})
