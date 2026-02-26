/**
 * Structured metric types emitted by OMG pipeline stages.
 * All types are immutable and serializable to JSON.
 */

/** Metrics emitted at the end of the Extract phase. */
export interface ExtractMetrics {
  readonly stage: 'extract'
  readonly candidatesCount: number
  readonly parserRejectCount: number
  readonly parserRejectReasons: readonly string[]
  readonly writtenNodesCount: number
}

/** Per-cluster metrics emitted during clustered reflection. */
export interface ReflectionMetrics {
  readonly stage: 'reflection'
  readonly clusterCount: number
  readonly nodesPerCluster: readonly number[]
  readonly tokensInPerCluster: readonly number[]
  readonly tokensOutPerCluster: readonly number[]
  readonly reflectionNodesWritten: number
  readonly nodesArchived: number
}

/** Metrics emitted at the end of context selection. */
export interface SelectorMetrics {
  readonly stage: 'selector'
  readonly injectedChars: number
  readonly injectedTokens: number
  readonly selectedNodeCountByType: Readonly<Record<string, number>>
  readonly selectedNodeCountByDomain: Readonly<Record<string, number>>
  readonly memorySearchHitCount: number
}

/** Cumulative error metrics per pipeline run. */
export interface ErrorMetrics {
  readonly stage: 'error'
  readonly rateLimitCount: number
  readonly timeoutCount: number
  readonly parseFailureCount: number
  readonly retryCount: number
}

/** Metrics emitted at the end of a semantic dedup run. */
export interface SemanticDedupMetrics {
  readonly stage: 'semantic-dedup'
  readonly blocksProcessed: number
  readonly mergesExecuted: number
  readonly nodesArchived: number
  readonly tokensUsed: number
}

/** Metrics emitted by extraction guardrails. */
export interface GuardrailMetrics {
  readonly stage: 'guardrail'
  readonly overlapScore: number
  readonly action: 'proceed' | 'truncate' | 'skip'
  readonly candidatesSuppressed: number
  readonly candidatesSurvived: number
}

/** Union of all metric payload types. */
export type MetricData = ExtractMetrics | ReflectionMetrics | SelectorMetrics | ErrorMetrics | SemanticDedupMetrics | GuardrailMetrics

/** A timestamped metric event carrying one of the metric payloads. */
export interface MetricEvent {
  readonly stage: MetricData['stage']
  readonly timestamp: string
  readonly data: MetricData
}
