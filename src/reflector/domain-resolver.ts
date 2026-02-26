/**
 * Resolves the primary domain for graph nodes based on their registry entries.
 *
 * Domain resolution priority:
 *   1. First `omg/moc-*` link → extract domain slug
 *   2. canonicalKey prefix mapping (identity.*, preferences.*, etc.)
 *   3. Default: 'misc'
 */

import type { RegistryNodeEntry } from '../graph/registry.js'

/** Prefix-to-domain mapping for canonicalKey-based resolution. */
const PREFIX_DOMAIN_MAP: ReadonlyMap<string, string> = new Map([
  ['identity', 'identity'],
  ['identities', 'identity'],
  ['preference', 'preferences'],
  ['preferences', 'preferences'],
  ['project', 'projects'],
  ['projects', 'projects'],
  ['decision', 'decisions'],
  ['decisions', 'decisions'],
])

const MOC_LINK_RE = /^omg\/moc-(.+)$/

/**
 * Resolves the primary domain for a single registry entry.
 *
 * Priority:
 *   1. First `omg/moc-{domain}` in links → domain slug
 *   2. canonicalKey prefix → mapped domain
 *   3. 'misc'
 */
export function resolvePrimaryDomain(entry: RegistryNodeEntry): string {
  // Priority 1: MOC link
  const links = entry.links ?? []
  for (const link of links) {
    const match = MOC_LINK_RE.exec(link)
    if (match?.[1]) {
      return match[1]
    }
  }

  // Priority 2: canonicalKey prefix
  if (entry.canonicalKey) {
    const dotIndex = entry.canonicalKey.indexOf('.')
    if (dotIndex > 0) {
      const prefix = entry.canonicalKey.slice(0, dotIndex).toLowerCase()
      const mapped = PREFIX_DOMAIN_MAP.get(prefix)
      if (mapped) return mapped
    }
  }

  // Priority 3: default
  return 'misc'
}

/**
 * Groups registry entries by their primary domain.
 *
 * Returns an immutable map of domain → entry tuples (preserving the [id, entry] pairs).
 */
export function assignDomains(
  entries: readonly [string, RegistryNodeEntry][],
): ReadonlyMap<string, readonly [string, RegistryNodeEntry][]> {
  const result = new Map<string, readonly [string, RegistryNodeEntry][]>()
  for (const pair of entries) {
    const domain = resolvePrimaryDomain(pair[1])
    const existing = result.get(domain)
    result.set(domain, existing ? [...existing, pair] : [pair])
  }
  return result
}
