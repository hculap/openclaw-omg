/**
 * Barrel export for the semantic dedup subsystem.
 */
export { runDedup } from './dedup.js'
export type { DedupParams } from './dedup.js'
export type { DedupRunResult, DedupState, DedupAuditEntry, MergePlan, DedupConfig } from './types.js'
export { loadDedupState, saveDedupState } from './state.js'
export { readAuditLog, appendAuditEntry } from './audit.js'
