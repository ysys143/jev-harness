// What leaves the machine for Jev is scrubbed first: secret-shaped strings,
// email addresses and the home folder never go out.

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Long opaque runs: hex or base64 of 32 characters or more. A slash or a
  // hyphen ends a run, so long paths and slugs stay readable (a live run
  // scrubbed them whole); known token shapes are caught by the patterns above.
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+_]{40,}={0,2}/g,
]

// NAME=value where NAME says it is secret: the name stays, the value goes.
const NAMED_SECRET = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function scrub(text: string, home?: string): string {
  let out = text
  const root = home?.replace(/\/+$/, '')
  if (root !== undefined && root.length > 1) out = out.replace(new RegExp(escapeRegExp(root), 'g'), '~')
  out = out.replace(NAMED_SECRET, (_, name: string, sep: string) => `${name}${sep}<secret>`)
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '<secret>')

  return out.replace(EMAIL, '<email>')
}
