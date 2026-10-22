// The TypeSafe key, from the first source that has one. Never logged or shown.

export type KeySource = 'config' | 'dotenv' | 'env'

/** The value of the TYPESAFE_API_KEY line of a .env text; other lines are ignored. */
export function keyFromDotenv(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const match = /^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[1]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (value !== '') return value
  }

  return undefined
}

/** The first key found, in order: the plugin's sensitive setting, its .env, the environment. */
export function pickKey(sources: { config?: unknown; dotenv?: string; env?: string }): { key: string; source: KeySource } | undefined {
  if (typeof sources.config === 'string' && sources.config.trim() !== '') return { key: sources.config.trim(), source: 'config' }
  const fromFile = sources.dotenv === undefined ? undefined : keyFromDotenv(sources.dotenv)
  if (fromFile !== undefined) return { key: fromFile, source: 'dotenv' }
  if (typeof sources.env === 'string' && sources.env.trim() !== '') return { key: sources.env.trim(), source: 'env' }

  return undefined
}
