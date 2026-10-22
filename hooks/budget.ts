// How many Jev calls a point may still make in a session, and its circuit.

export type BudgetState = { calls: number; failures: number; openUntil: number }

export const EMPTY_BUDGET: BudgetState = { calls: 0, failures: 0, openUntil: 0 }

const CIRCUIT_FAILURES = 3
const CIRCUIT_OPEN_MS = 5 * 60 * 1000

export function readBudget(value: unknown): BudgetState {
  if (value === null || typeof value !== 'object') return EMPTY_BUDGET
  const { calls, failures, openUntil } = value as Record<string, unknown>
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

  return { calls: count(calls), failures: count(failures), openUntil: count(openUntil) }
}

/** Whether a call may go out now, and if not, why. */
export function admit(state: BudgetState, cap: number, now: number): 'ok' | 'cap' | 'circuit' {
  if (state.openUntil > now) return 'circuit'
  if (state.calls >= cap) return 'cap'

  return 'ok'
}

/** The state after one call: success closes the circuit, the third failure in a row opens it. */
export function afterCall(state: BudgetState, isOk: boolean, now: number): BudgetState {
  if (isOk) return { calls: state.calls + 1, failures: 0, openUntil: 0 }
  const failures = state.failures + 1

  return {
    calls: state.calls + 1,
    failures: failures >= CIRCUIT_FAILURES ? 0 : failures,
    openUntil: failures >= CIRCUIT_FAILURES ? now + CIRCUIT_OPEN_MS : state.openUntil,
  }
}
