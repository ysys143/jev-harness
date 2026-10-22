import { expect, test } from 'claude-code/testing'
import { admit, afterCall, EMPTY_BUDGET } from '../hooks/budget'
import { checkAnswer, parseResponse, probabilityOf, type JevQuestion } from '../hooks/jev'
import { keyFromDotenv, pickKey } from '../hooks/key'
import { confusion, kappa, percentile, pointReport, sweep, type ShadowRecord } from '../hooks/report'
import { scrub } from '../hooks/scrub'
import { STOP_QUESTION, announcesByRule, lastParagraph, stopSkipReason } from '../hooks/stop-gate'
import {
  canWrite,
  decideTrust,
  normalizePath,
  pathCandidates,
  pathFieldValues,
  restrictedReason,
  secretDumpReason,
  selfProtectReason,
  type TrustFacts,
} from '../hooks/tool-gate'

const HOME = '/Users/me'

test('choice answers need a known choice and probabilities for exactly the criteria', () => {
  const good = { type: 'choice', choice: 'announce', confidence: 0.98, probabilities: { announce: 0.99, report: 0.01 } }
  expect(checkAnswer(good, STOP_QUESTION)).toEqual({ type: 'choice', value: 'announce', confidence: 0.98, probabilities: { announce: 0.99, report: 0.01 } })
  expect(checkAnswer({ ...good, choice: 'maybe' }, STOP_QUESTION)).toBe(undefined)
  expect(checkAnswer({ ...good, probabilities: { announce: 0.99 } }, STOP_QUESTION)).toBe(undefined)
  expect(checkAnswer({ ...good, probabilities: { announce: 1.2, report: 0 } }, STOP_QUESTION)).toBe(undefined)
  expect(checkAnswer({ ...good, type: 'noul' }, STOP_QUESTION)).toBe(undefined)
})

test('noul is a number in [0, 1] as measured; a boolean counts as 0 or 1', () => {
  const noul: JevQuestion = { type: 'noul', instructions: 'q', criteria: { true: 'y', false: 'n' } }
  expect(probabilityOf(checkAnswer({ type: 'noul', noul: 0.94 }, noul)!)).toBe(0.94)
  expect(probabilityOf(checkAnswer({ type: 'noul', noul: true }, noul)!)).toBe(1)
  expect(checkAnswer({ type: 'noul', noul: 1.5 }, noul)).toBe(undefined)
  expect(checkAnswer({ type: 'noul', noul: 'yes' }, noul)).toBe(undefined)
})

test('score answers stay within the criteria and keep index-keyed probabilities', () => {
  const score: JevQuestion = { type: 'score', instructions: 'q', criteria: ['a', 'b', 'c', 'd'] }
  const answer = checkAnswer({ type: 'score', score: 2.07, confidence: 0.9, probabilities: { 0: 0, 1: 0.01, 2: 0.9, 3: 0.09 } }, score)
  expect(answer?.value).toBe(2.07)
  expect(answer?.probabilities?.['2']).toBe(0.9)
  expect(checkAnswer({ type: 'score', score: 3.5 }, score)).toBe(undefined)
})

test('a response must answer every question asked', () => {
  const body = JSON.stringify({
    model: 'jev-1.14.0',
    answers: { stop: { type: 'choice', choice: 'report', confidence: 0.99, probabilities: { announce: 0.01, report: 0.99 } } },
    usage: { input_tokens: 373, output_tokens: 31 },
  })
  const parsed = parseResponse(body, { stop: STOP_QUESTION })
  expect(parsed.ok).toBe(true)
  if (parsed.ok) {
    expect(probabilityOf(parsed.answers.stop!, 'announce')).toBe(0.01)
    expect(parsed.usage).toEqual({ input_tokens: 373, output_tokens: 31 })
  }
  expect(parseResponse(body, { stop: STOP_QUESTION, other: STOP_QUESTION }).ok).toBe(false)
  expect(parseResponse('not json', { stop: STOP_QUESTION }).ok).toBe(false)
  expect(parseResponse('{"answers":{}}', { stop: STOP_QUESTION }).ok).toBe(false)
})

test('the key comes from the sensitive setting, then the .env line, then the environment', () => {
  expect(keyFromDotenv('A=1\nexport TYPESAFE_API_KEY="tk-1"\nB=2')).toBe('tk-1')
  expect(keyFromDotenv("TYPESAFE_API_KEY='tk-2'")).toBe('tk-2')
  expect(keyFromDotenv('# TYPESAFE_API_KEY=x\nOTHER=1')).toBe(undefined)
  expect(pickKey({ config: 'from-config', dotenv: 'TYPESAFE_API_KEY=from-file', env: 'from-env' })).toEqual({ key: 'from-config', source: 'config' })
  expect(pickKey({ config: '', dotenv: 'TYPESAFE_API_KEY=from-file', env: 'from-env' })).toEqual({ key: 'from-file', source: 'dotenv' })
  expect(pickKey({ dotenv: 'OTHER=1', env: 'from-env' })).toEqual({ key: 'from-env', source: 'env' })
  expect(pickKey({})).toBe(undefined)
})

test('scrub removes secrets, addresses and the home folder', () => {
  const text = `Bearer abcdefghijkl1234 sk-ant-api03-AAAAAAAAAAAAAAAAAAAA a@b.co ${HOME}/code DB_PASSWORD=hunter2 ghp_ABCDEFGHIJKLMNOPQRSTUV12`
  const out = scrub(text, HOME)
  expect(out).not.toContain('abcdefghijkl1234')
  expect(out).not.toContain('sk-ant-api03')
  expect(out).not.toContain('a@b.co')
  expect(out).not.toContain('hunter2')
  expect(out).not.toContain('ghp_')
  expect(out).toContain('~/code')
  expect(out).toContain('DB_PASSWORD=<secret>')
  // A long path is not a secret: seen scrubbed whole in a live run.
  const path = '/private/tmp/claude-501/-Users-me-Documents-GitHub-some-project-e0b394b8-00ae-483d-ab66-4cf014489a1d/scratchpad/greet.py'
  expect(scrub(`changed ${path}`, HOME)).toBe(`changed ${path}`)
})

test('the budget stops at the cap and opens the circuit after three failures in a row', () => {
  expect(admit({ ...EMPTY_BUDGET, calls: 2 }, 2, 0)).toBe('cap')
  let state = EMPTY_BUDGET
  for (let i = 0; i < 2; i++) state = afterCall(state, false, 1000)
  expect(admit(state, 100, 1000)).toBe('ok')
  state = afterCall(state, false, 1000)
  expect(admit(state, 100, 1000 + 60_000)).toBe('circuit')
  expect(admit(state, 100, 1000 + 5 * 60_000 + 1)).toBe('ok')
  expect(afterCall({ calls: 1, failures: 2, openUntil: 0 }, true, 0)).toEqual({ calls: 2, failures: 0, openUntil: 0 })
})

test('the last paragraph skips code blocks and tables and keeps its end', () => {
  const message = 'Intro.\n\nI changed the parser.\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'
  expect(lastParagraph(message)).toBe('I changed the parser.')
  expect(lastParagraph(`a\n\n${'x'.repeat(700)}`).length).toBe(600)
  expect(lastParagraph(undefined)).toBe('')
})

test('the rule flags announcing endings, not reports, questions or approval-conditioned ones', () => {
  expect(announcesByRule('파서를 고쳤습니다. 이어서 캐시를 리팩터링하겠습니다.')).toBe(true)
  expect(announcesByRule('I fixed the parser. Next, I will refactor the cache.')).toBe(true)
  expect(announcesByRule('I fixed the parser and all tests pass.')).toBe(false)
  expect(announcesByRule('Let me know if you want the cache refactored.')).toBe(false)
  expect(announcesByRule('승인해 주시면 진행하겠습니다.')).toBe(false)
  // Seen in replayed transcripts: endings that wait on the person or on running work.
  expect(announcesByRule('어느 쪽인지 알려주시면 처리하겠습니다.')).toBe(false)
  expect(announcesByRule('결과가 나오면 다시 말씀드리겠습니다.')).toBe(false)
  expect(announcesByRule('셋 다 모이면 한 번에 정리해 머지하겠습니다.')).toBe(false)
  expect(announcesByRule('I will merge once the checks pass.')).toBe(false)
  expect(announcesByRule('정확한 현재 상태를 확인하겠습니다.')).toBe(true)
})

test('stops that are not judged say why', () => {
  const base = { stopHookActive: false, backgroundTasks: 0, scheduledTasks: 0, paragraph: '고치겠습니다.' }
  expect(stopSkipReason(base)).toBe(undefined)
  expect(stopSkipReason({ ...base, agentId: 'a1' })).toBe('subagent')
  expect(stopSkipReason({ ...base, stopHookActive: true })).toBe('stop-hook-active')
  expect(stopSkipReason({ ...base, permissionMode: 'plan' })).toBe('plan-mode')
  expect(stopSkipReason({ ...base, backgroundTasks: 1 })).toBe('background-tasks')
  expect(stopSkipReason({ ...base, scheduledTasks: 1 })).toBe('scheduled-tasks')
  expect(stopSkipReason({ ...base, paragraph: '' })).toBe('empty')
  expect(stopSkipReason({ ...base, paragraph: '캐시도 고칠까요?' })).toBe('question')
  expect(stopSkipReason({ ...base, paragraph: '원하시면 캐시도 고치겠습니다.' })).toBe('conditional')
})

const FIRST_PARTY: TrustFacts = { isAuthorized: true, proxies: [], thirdParty: [], override: 'auto', trustedProxies: [] }

test('a session is first-party only when every sign agrees', () => {
  expect(decideTrust(FIRST_PARTY).trust).toBe('first-party')
  expect(decideTrust({ ...FIRST_PARTY, baseUrl: 'https://api.anthropic.com' }).trust).toBe('first-party')
  expect(decideTrust({ ...FIRST_PARTY, isAuthorized: false }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, proxies: ['http://127.0.0.1:10100'] }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, caCerts: '/tmp/ca.pem' }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, thirdParty: ['CLAUDE_CODE_USE_BEDROCK'] }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, baseUrl: 'http://api.anthropic.com' }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, baseUrl: 'https://anthropic.com.evil.io' }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, baseUrl: 'http://127.0.0.1:9099' }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, baseUrl: 'http://127.0.0.1:9100', trustedProxies: ['127.0.0.1:9100'] }).trust).toBe('first-party')
  expect(decideTrust({ ...FIRST_PARTY, override: 'external' }).trust).toBe('external')
  expect(decideTrust({ ...FIRST_PARTY, baseUrl: 'not a url' }).trust).toBe('external')
})

test('paths resolve ~, $HOME, . and .. before they are judged', () => {
  expect(normalizePath('~/.ssh/id_rsa', HOME, '/p')).toBe(`${HOME}/.ssh/id_rsa`)
  expect(normalizePath('$HOME/.env', HOME, '/p')).toBe(`${HOME}/.env`)
  expect(normalizePath('../x/./.ENV', HOME, '/p/q')).toBe('/p/x/.ENV')
})

test('the floor names real secret stores and leaves look-alikes alone', () => {
  const r = (p: string) => restrictedReason(p, HOME)
  expect(r('/p/.env')).toBe('env file')
  expect(r('/p/.ENV.production')).toBe('env file')
  expect(r(`${HOME}/.oh-my-zsh/custom/apikey.env`)).toBe('env file')
  expect(r('/p/.env.example')).toBe(undefined)
  expect(r('/p/.env.tpl')).toBe(undefined)
  expect(r(`${HOME}/.ssh/id_ed25519`)).toBe('ssh')
  expect(r(`${HOME}/.ssh/id_ed25519.pub`)).toBe(undefined)
  expect(r(`${HOME}/.ssh/known_hosts`)).toBe(undefined)
  expect(r(`${HOME}/.codex-3/auth.json`)).toBe('codex auth')
  expect(r(`${HOME}/.claude-3/.credentials.json`)).toBe('claude credentials')
  expect(r(`${HOME}/.opencodex/claude-intercept/proxy-token`)).toBe('proxy credentials')
  expect(r(`${HOME}/.config/gh/hosts.yml`)).toBe('tool credentials')
  expect(r('/p/server.pem')).toBe('key material')
  expect(r('/p/src/id_mapping.py')).toBe(undefined)
  expect(r('/p/talk.key')).toBe(undefined)
  expect(r('/p/.venv/bin/python')).toBe(undefined)
})

test('shell paths are found behind git pathspecs, options and redirects', () => {
  expect(pathCandidates('git diff --no-index /dev/null .env')).toContain('.env')
  expect(pathCandidates('git show :.env')).toContain('.env')
  expect(pathCandidates('git show HEAD:config/.env.prod')).toContain('config/.env.prod')
  expect(pathCandidates('tool --file=.env')).toContain('.env')
  expect(pathCandidates('python x.py <.env')).toContain('.env')
  expect(pathCandidates('cat "my dir/.env"')).toContain('my dir/.env')
})

test('commands that print the environment or a stored secret are named', () => {
  expect(secretDumpReason('printenv')).toBe('printenv')
  expect(secretDumpReason('env | grep KEY')).toBe('env')
  expect(secretDumpReason('env FOO=1 node app.js')).toBe(undefined)
  expect(secretDumpReason('sudo env')).toBe('env')
  expect(secretDumpReason('export -p')).toBe('export')
  expect(secretDumpReason('security find-generic-password -s svc -w')).toBe('keychain secret')
  expect(secretDumpReason('gh auth token')).toBe('gh token')
  expect(secretDumpReason('ls -la && git status')).toBe(undefined)
})

test('writes are told apart from reads', () => {
  expect(canWrite('Write')).toBe(true)
  expect(canWrite('Read')).toBe(false)
  expect(canWrite('Bash', 'echo x > hooks/a.ts')).toBe(true)
  expect(canWrite('Bash', 'sed -i "" s/a/b/ f')).toBe(true)
  expect(canWrite('Bash', 'ls 2>&1 > /dev/null')).toBe(false)
  expect(canWrite('Bash', 'cat settings.json')).toBe(false)
})

test('the plugin, its logs and Claude settings are protected from the agent', () => {
  const roots = ['/plugins/jev-harness', `${HOME}/.local/state/jev-harness`]
  expect(selfProtectReason('/plugins/jev-harness/hooks/register.ts', roots)).toBe('jev-harness files')
  expect(selfProtectReason(`${HOME}/.claude-3/settings.json`, roots)).toBe('claude settings')
  expect(selfProtectReason('/p/src/settings.json', roots)).toBe(undefined)
})

test('path fields are read from any tool input, nested ones included', () => {
  expect(pathFieldValues({ file_path: '/a', old_string: '/not/this', notebook_path: '/b', options: { filePath: '/c' }, paths: ['/d'] }).sort()).toEqual(['/a', '/b', '/c', '/d'])
})

test('agreement metrics: confusion, kappa, percentiles and a threshold sweep', () => {
  const c = confusion([
    { rule: true, jev: true },
    { rule: true, jev: false },
    { rule: false, jev: false },
    { rule: false, jev: false },
  ])
  expect(c).toEqual({ both: 1, ruleOnly: 1, jevOnly: 0, neither: 2 })
  expect(kappa(c)?.toFixed(2)).toBe('0.50')
  expect(percentile([5, 1, 3], 0.5)).toBe(3)
  const s = sweep([{ probability: 0.9, label: true }, { probability: 0.8, label: false }, { probability: 0.2, label: true }], [0.5, 0.85])
  expect(s[0]).toEqual({ threshold: 0.5, precision: 0.5, recall: 0.5, positives: 2 })
  expect(s[1]).toEqual({ threshold: 0.85, precision: 1, recall: 0.5, positives: 1 })
})

test('the report lists disagreements to label and the sweep once labels exist', () => {
  const base: ShadowRecord = { id: 'a', ts: 't', sessionId: 's', point: 'stop', mode: 'shadow', sent: {}, hookMs: 1, jevMs: 200 }
  const records = [
    { ...base, id: 'r1', heuristic: true, jev: 0.99 },
    { ...base, id: 'r2', heuristic: false, jev: 0.95 },
    { ...base, id: 'r3', heuristic: false, jev: 0.01 },
    { ...base, id: 'r4', skipped: 'question', sent: null },
  ]
  const text = pointReport('stop', records, new Map([['r1', true]]), 0.7)
  expect(text).toContain('records 4, eligible 3, sent 3, answered 3')
  expect(text).toContain('skipped: question 1')
  expect(text).toContain('both 1, rule only 0, jev only 1, neither 1')
  expect(text).toContain('/jev-mark <id> y|n): r2')
  expect(text).toContain('labels 1 (positive 1, negative 0)')
})
