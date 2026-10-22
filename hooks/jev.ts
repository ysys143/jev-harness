// The Jev request and response, as plain data: building the body, checking
// the answer, and turning it into one probability. Sending is register.ts's.

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: 'score'; instructions: string; criteria: readonly string[] }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }

export type JevAnswer = {
  type: 'choice' | 'score' | 'noul'
  value: string | number
  confidence?: number
  probabilities?: Record<string, number>
}

export type JevUsage = { input_tokens: number; output_tokens: number }

export type JevFailure = 'timeout' | 'http' | 'invalid' | 'cap' | 'circuit' | 'no-key' | 'network'

export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevAnswer>; usage?: JevUsage; ms: number }
  | { ok: false; kind: JevFailure; status?: number; ms: number }

export function requestBody(state: Readonly<Record<string, unknown>>, questions: Readonly<Record<string, JevQuestion>>): string {
  return JSON.stringify({ state, questions, model: JEV_MODEL })
}

const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const probabilitiesOf = (value: unknown, keys: readonly string[]): Record<string, number> | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== keys.length || !entries.every(([key, p]) => keys.includes(key) && isProbability(p))) return undefined

  return Object.fromEntries(entries) as Record<string, number>
}

/** One answer checked against the question it answers; undefined when it does not fit. */
export function checkAnswer(raw: unknown, question: JevQuestion): JevAnswer | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const answer = raw as Record<string, unknown>
  if (answer.type !== question.type) return undefined
  const confidence = isProbability(answer.confidence) ? answer.confidence : undefined

  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria)
    if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)) return undefined
    const probabilities = probabilitiesOf(answer.probabilities, keys)
    if (probabilities === undefined) return undefined

    return { type: 'choice', value: answer.choice, confidence, probabilities }
  }
  if (question.type === 'score') {
    const top = question.criteria.length - 1
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > top) return undefined
    const probabilities = probabilitiesOf(answer.probabilities, question.criteria.map((_, i) => String(i)))

    return { type: 'score', value: answer.score, confidence, probabilities }
  }
  // Measured with jev-1.14.0: noul is a number in [0, 1]; a boolean is accepted as 0 or 1.
  const noul = typeof answer.noul === 'boolean' ? Number(answer.noul) : answer.noul
  if (!isProbability(noul)) return undefined

  return { type: 'noul', value: noul, confidence }
}

/** The response body checked against the questions asked; every question must be answered. */
export function parseResponse(
  text: string,
  questions: Readonly<Record<string, JevQuestion>>,
): { ok: true; model: string; answers: Record<string, JevAnswer>; usage?: JevUsage } | { ok: false } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (body === null || typeof body !== 'object') return { ok: false }
  const { model, answers, usage } = body as Record<string, unknown>
  if (typeof model !== 'string' || answers === null || typeof answers !== 'object') return { ok: false }

  const checked: Record<string, JevAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const answer = checkAnswer((answers as Record<string, unknown>)[name], question)
    if (answer === undefined) return { ok: false }
    checked[name] = answer
  }
  const tokens = usage as Record<string, unknown> | undefined
  const counted =
    tokens && typeof tokens.input_tokens === 'number' && typeof tokens.output_tokens === 'number'
      ? { input_tokens: tokens.input_tokens, output_tokens: tokens.output_tokens }
      : undefined

  return { ok: true, model, answers: checked, usage: counted }
}

/** The probability of `key` for a choice, or of true for a noul. */
export function probabilityOf(answer: JevAnswer, key = 'true'): number | undefined {
  if (answer.type === 'noul') return typeof answer.value === 'number' ? answer.value : undefined

  return answer.probabilities?.[key]
}
