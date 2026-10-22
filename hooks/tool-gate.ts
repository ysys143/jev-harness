// E2 floor: who serves this session, and which paths and commands a tool
// call touches that must not reach a provider other than Anthropic.

export const TOOL_POINT = 'tool'

export type Trust = 'first-party' | 'external'

export type TrustFacts = {
  /** $.session.authorize() returned a first-party credential. */
  isAuthorized: boolean
  baseUrl?: string
  /** Values of HTTPS_PROXY, HTTP_PROXY and their lower-case forms that are set. */
  proxies: readonly string[]
  caCerts?: string
  /** Names of CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY that are set. */
  thirdParty: readonly string[]
  override: 'auto' | 'external'
  /** host:port of local proxies known to forward to Anthropic. */
  trustedProxies: readonly string[]
}

/** First-party only when every sign agrees; anything else is external. */
export function decideTrust(facts: TrustFacts): { trust: Trust; why: string } {
  if (facts.override === 'external') return { trust: 'external', why: 'providerTrust=external' }
  if (facts.thirdParty.length > 0) return { trust: 'external', why: facts.thirdParty.join(',') }
  if (!facts.isAuthorized) return { trust: 'external', why: 'no first-party credential' }
  if (facts.proxies.length > 0) return { trust: 'external', why: 'proxy set' }
  if (facts.caCerts !== undefined && facts.caCerts !== '') return { trust: 'external', why: 'NODE_EXTRA_CA_CERTS set' }
  if (facts.baseUrl === undefined || facts.baseUrl.trim() === '') return { trust: 'first-party', why: 'default endpoint' }

  let url: URL
  try {
    url = new URL(facts.baseUrl)
  } catch {
    return { trust: 'external', why: 'unparsable ANTHROPIC_BASE_URL' }
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol === 'https:' && (host === 'anthropic.com' || host.endsWith('.anthropic.com'))) return { trust: 'first-party', why: host }
  if (facts.trustedProxies.includes(url.host.toLowerCase())) return { trust: 'first-party', why: `trusted ${url.host}` }

  return { trust: 'external', why: `ANTHROPIC_BASE_URL ${host}` }
}

/** An absolute path with ~, $HOME and . / .. resolved, its case kept; no file-system access. */
export function normalizePath(raw: string, home: string, cwd: string): string {
  let path = raw.trim()
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1)
  path = path.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
  if (!path.startsWith('/')) path = `${cwd.replace(/\/+$/, '')}/${path}`
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.tpl', '.dist']

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Why an absolute path is restricted, or undefined. Compared in lower case: APFS ignores case. */
export function restrictedReason(absolute: string, home: string): string | undefined {
  const path = absolute.toLowerCase()
  const h = home.toLowerCase().replace(/\/+$/, '')
  const name = basename(path)
  const under = (dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

  if (name === '.env' || name.startsWith('.env.') || (name.endsWith('.env') && name !== '.env')) {
    if (!TEMPLATE_SUFFIXES.some(suffix => name.endsWith(suffix))) return 'env file'
  }
  if (under(`${h}/.ssh`) && !name.endsWith('.pub') && name !== 'known_hosts') return 'ssh'
  if (under(`${h}/.aws`) || under(`${h}/.gnupg`) || under(`${h}/.config/gcloud`)) return 'cloud credentials'
  if (path === `${h}/.kube/config` || path === `${h}/.docker/config.json` || path === `${h}/.config/gh/hosts.yml`) return 'tool credentials'
  if (/\/\.codex[^/]*\/auth\.json$/.test(path)) return 'codex auth'
  if (under(`${h}/.opencodex`) && /\/(auth\.json|admin-api-token|proxy-token)$/.test(path)) return 'proxy credentials'
  if (/\/\.claude[^/]*\/\.credentials\.json$/.test(path)) return 'claude credentials'
  if (['.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials'].includes(name)) return 'credential file'
  if (/\.(pem|p12|pfx|kdbx|keystore|jks)$/.test(name)) return 'key material'
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(name)) return 'ssh key'
  if (/^\/proc\/[^/]+\/environ$/.test(path)) return 'process environment'

  return undefined
}

/** Tokens of a shell command, quotes removed, operators as their own tokens. */
export function shellTokens(command: string): string[] {
  const spaced = command.replace(/(\|\||&&|;|\||&|\$\(|`|\(|\)|\n)/g, ' $1 ')
  const tokens = spaced.match(/"[^"]*"|'[^']*'|\S+/g) ?? []

  return tokens.map(token => token.replace(/^(["'])([\s\S]*)\1$/, '$2'))
}

const OPERATORS = new Set(['||', '&&', ';', '|', '&', '$(', '`', '(', ')', '\n'])
const WRAPPERS = new Set(['sudo', 'command', 'nohup', 'time', 'xargs', 'stdbuf', 'nice', 'doas', 'setsid', 'exec'])
const isAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)

/** Each simple command of a shell line: its word and its arguments. */
export function shellCommands(command: string): { word: string; args: string[] }[] {
  const out: { word: string; args: string[] }[] = []
  let current: string[] = []
  const flush = (): void => {
    let i = 0
    while (i < current.length && (isAssignment(current[i]!) || WRAPPERS.has(basename(current[i]!)))) i++
    if (i < current.length) out.push({ word: basename(current[i]!), args: current.slice(i + 1) })
    current = []
  }
  for (const token of shellTokens(command)) {
    if (OPERATORS.has(token)) flush()
    else current.push(token)
  }
  flush()

  return out
}

/** Strings in a command that may name a file: tokens, the parts after = or :, redirect targets. */
export function pathCandidates(command: string): string[] {
  const found = new Set<string>()
  for (const token of shellTokens(command)) {
    if (OPERATORS.has(token)) continue
    const bare = token.replace(/^[0-9]*[<>]+&?/, '')
    for (const part of [bare, ...bare.split(/[=:]/).slice(1)]) if (part !== '' && !part.startsWith('-')) found.add(part)
  }

  return [...found]
}

/** A command that prints the environment or a stored secret. */
export function secretDumpReason(command: string): string | undefined {
  for (const { word, args } of shellCommands(command)) {
    const rest = args.filter(arg => !isAssignment(arg))
    if (word === 'printenv') return 'printenv'
    if (word === 'env' && rest.filter(arg => !arg.startsWith('-')).length === 0) return 'env'
    if ((word === 'export' && (args.length === 0 || args.includes('-p'))) || (word === 'declare' && args.some(a => /^-[a-z]*[xp]/.test(a)))) return word
    if (word === 'set' && args.length === 0) return 'set'
    if (word === 'security' && args.some(a => /^find-(generic|internet)-password$/.test(a)) && args.some(a => a === '-w' || a === '-g')) return 'keychain secret'
    if (word === 'gh' && args[0] === 'auth' && (args[1] === 'token' || args.includes('--show-token') || args.includes('-t'))) return 'gh token'
  }

  return undefined
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const WRITE_WORDS = new Set(['rm', 'mv', 'cp', 'tee', 'chmod', 'chown', 'truncate', 'dd', 'install', 'ln', 'rsync', 'unlink'])

/** Whether a tool call can change files: a write tool, or a shell line with a redirect or a writing command. */
export function canWrite(tool: string, command?: string): boolean {
  if (WRITE_TOOLS.has(tool)) return true
  if (command === undefined) return false
  if (/(^|[^0-9&<])>{1,2}(?!&)/.test(command.replace(/\d?>\s*\/dev\/null/g, ''))) return true

  return shellCommands(command).some(({ word, args }) => WRITE_WORDS.has(word) || (word === 'sed' && args.some(a => /^-[a-z]*i/.test(a))))
}

/** Why writing to an absolute path would let the agent switch the gates off, or undefined. */
export function selfProtectReason(absolute: string, protectedRoots: readonly string[]): string | undefined {
  const path = absolute.toLowerCase()
  const roots = protectedRoots.map(root => root.toLowerCase().replace(/\/+$/, ''))
  if (roots.some(root => path === root || path.startsWith(`${root}/`))) return 'jev-harness files'
  if (/\/\.claude[^/]*\/settings(\.local)?\.json$/.test(path)) return 'claude settings'

  return undefined
}

// Input fields that name files across tools: file_path, notebook_path, path,
// filePath (LSP), paths, target, source, destination, cwd, directory.
const PATH_FIELD = /(^|_)(path|paths|file|files|filepath|notebook|target|source|destination|dest|dir|directory|cwd)$|path$/i

/** String values of a tool's input under file-naming keys, at most three levels down. */
export function pathFieldValues(input: unknown, depth = 0): string[] {
  if (depth >= 3 || input === null || typeof input !== 'object') return []
  const out: string[] = []
  for (const [key, value] of Object.entries(input)) {
    const isPathKey = PATH_FIELD.test(key)
    if (typeof value === 'string' && isPathKey) out.push(value)
    else if (Array.isArray(value) && isPathKey) out.push(...value.filter((v): v is string => typeof v === 'string'))
    else if (value !== null && typeof value === 'object') out.push(...pathFieldValues(value, depth + 1))
  }

  return out
}

export type FloorVerdict = { reason: string; path?: string; kind: 'restricted' | 'secret-dump' | 'self' }

export function denyMessage(verdict: FloorVerdict, trust: Trust): string {
  if (verdict.kind === 'self') return `jev-harness: ${verdict.path ?? 'this path'} holds ${verdict.reason}; an agent may not change it.`

  return `jev-harness: this call touches ${verdict.reason}${verdict.path ? ` (${verdict.path})` : ''}, and this session is served by a provider other than Anthropic (${trust}). Do it from a first-party session instead.`
}
