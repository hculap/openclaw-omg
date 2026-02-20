import { z } from 'zod'

/**
 * Formats a Zod issue path as a human-readable dot/bracket string.
 *
 * Examples:
 *   []                              → "(root)"
 *   ["observer", "model"]           → "observer.model"
 *   ["injection", "pinnedNodes", 0] → "injection.pinnedNodes[0]"
 */
export function formatZodPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '(root)'
  return path
    .map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join('')
}

/**
 * Formats a `ZodError` into a multi-line indented string, one line per issue.
 * Each line is indented with two spaces and contains the field path and message.
 */
export function formatZodErrors(errors: readonly z.ZodIssue[]): string {
  return errors
    .map((issue) => `  ${formatZodPath(issue.path)}: ${issue.message}`)
    .join('\n')
}
