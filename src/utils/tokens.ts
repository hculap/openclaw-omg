const CHARS_PER_TOKEN = 4

/**
 * Fast token count estimate using a 4-characters-per-token heuristic.
 * Returns Math.ceil(text.length / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Returns true if the estimated token count for `text` fits within `budget`.
 */
export function fitsInBudget(text: string, budget: number): boolean {
  return estimateTokens(text) <= budget
}
