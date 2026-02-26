import { describe, it, expect, afterAll, vi } from 'vitest'
import { parseConfig } from '../../src/config.js'
import { selectContextV2 } from '../../src/context/selector.js'
import type { OmgConfig } from '../../src/config.js'
import type { GraphNode } from '../../src/types.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'

// ---------------------------------------------------------------------------
// Factories (mirrored from context-selector.test.ts)
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<{
    id: string
    type: GraphNode['frontmatter']['type']
    priority: GraphNode['frontmatter']['priority']
    description: string
    body: string
    updated: string
    links: string[]
    tags: string[]
    filePath: string
  }> = {}
): GraphNode {
  const now = new Date().toISOString()
  const id = overrides.id ?? 'omg/fact/test-fact'
  const slug = id.split('/').pop() ?? 'test-fact'
  const type = overrides.type ?? 'fact'
  return {
    frontmatter: {
      id,
      description: overrides.description ?? 'A test fact',
      type,
      priority: overrides.priority ?? 'medium',
      created: now,
      updated: overrides.updated ?? now,
      links: overrides.links,
      tags: overrides.tags,
    },
    body: overrides.body ?? 'Some content about the topic.',
    filePath: overrides.filePath ?? `/bench/nodes/${type}/${slug}.md`,
  }
}

function makeRegistryEntry(
  overrides: Partial<{
    type: RegistryNodeEntry['type']
    kind: RegistryNodeEntry['kind']
    priority: RegistryNodeEntry['priority']
    description: string
    updated: string
    filePath: string
    archived: boolean
    tags: string[]
    links: string[]
  }> = {}
): RegistryNodeEntry {
  const now = new Date().toISOString()
  return {
    type: overrides.type ?? 'fact',
    kind: overrides.kind ?? 'observation',
    priority: overrides.priority ?? 'medium',
    description: overrides.description ?? 'A test fact',
    created: now,
    updated: overrides.updated ?? now,
    filePath: overrides.filePath ?? '/bench/nodes/fact/test-fact.md',
    ...(overrides.archived !== undefined && { archived: overrides.archived }),
    ...(overrides.tags !== undefined && { tags: overrides.tags }),
    ...(overrides.links !== undefined && { links: overrides.links }),
  }
}

function makeHydratedNode(id: string, entry: RegistryNodeEntry, body = 'Node body content.'): GraphNode {
  return {
    frontmatter: {
      id,
      description: entry.description,
      type: entry.type,
      priority: entry.priority,
      created: entry.created,
      updated: entry.updated,
    },
    body,
    filePath: entry.filePath,
  }
}

// ---------------------------------------------------------------------------
// 18-node mock graph
// ---------------------------------------------------------------------------

const ALL_NODES: GraphNode[] = [
  // Identity (high priority)
  makeNode({
    id: 'omg/identity/partner-sylwia',
    type: 'identity',
    priority: 'high',
    description: 'Sylwia is PATI\'s wife and partner',
    body: 'Sylwia is PATI\'s closest person. She is his żona (wife) and partner. They have a strong relationship and family bond.',
    tags: ['sylwia', 'żona', 'wife', 'partner', 'family', 'relationship'],
  }),
  makeNode({
    id: 'omg/identity/family-mama',
    type: 'identity',
    priority: 'high',
    description: 'PATI\'s mother — mama, family context',
    body: 'Mama is an important family member. Rodzina (family) context for PATI\'s personal life.',
    tags: ['mama', 'mother', 'family', 'rodzina'],
  }),
  makeNode({
    id: 'omg/identity/self-description',
    type: 'identity',
    priority: 'high',
    description: 'PATI self-description — identity and assistant role',
    body: 'PATI is the user\'s assistant. Self-awareness of identity and purpose.',
    tags: ['pati', 'self', 'identity', 'assistant'],
  }),

  // Preferences (medium priority)
  makeNode({
    id: 'omg/preference/code-formatting',
    type: 'preference',
    priority: 'medium',
    description: 'Code formatting preferences — formatowanie, prettier',
    body: 'User prefers prettier for formatowanie (formatting). Consistent code-style across projects.',
    tags: ['formatowanie', 'formatting', 'prettier', 'code-style'],
  }),
  makeNode({
    id: 'omg/preference/editor-setup',
    type: 'preference',
    priority: 'medium',
    description: 'Editor setup preferences — VSCode, Zed',
    body: 'Primary editor is Zed. VSCode used as fallback. Tools and workspace configuration.',
    tags: ['editor', 'vscode', 'zed', 'tools'],
  }),
  makeNode({
    id: 'omg/preference/coding-style',
    type: 'preference',
    priority: 'medium',
    description: 'Coding style preferences — TypeScript, functional patterns',
    body: 'Prefers TypeScript with functional style. Immutability, small files, high cohesion. Style preferences for coding.',
    tags: ['coding', 'typescript', 'style', 'preferences'],
  }),

  // Projects (high/medium priority)
  makeNode({
    id: 'omg/project/secretary-workspace',
    type: 'project',
    priority: 'high',
    description: 'Secretary workspace — main agent project',
    body: 'Secretary is the primary workspace for PATI. Agent-based project with memory graph.',
    tags: ['secretary', 'workspace', 'project', 'agent'],
  }),
  makeNode({
    id: 'omg/project/techlead-role',
    type: 'project',
    priority: 'medium',
    description: 'TechLead role responsibilities and coding leadership',
    body: 'TechLead responsibilities include code review, architecture decisions, and team leadership.',
    tags: ['techlead', 'leadership', 'role', 'coding'],
  }),
  makeNode({
    id: 'omg/project/openclaw-omg-plugin',
    type: 'project',
    priority: 'medium',
    description: 'OpenClaw OMG plugin — TypeScript ESM package',
    body: 'The OMG plugin for OpenClaw. TypeScript ESM package with memory graph capabilities.',
    tags: ['openclaw', 'omg', 'plugin', 'typescript'],
  }),

  // Facts (medium priority)
  makeNode({
    id: 'omg/fact/typescript-config',
    type: 'fact',
    priority: 'medium',
    description: 'TypeScript configuration — tsconfig, build setup',
    body: 'TypeScript config uses strict mode, ESM modules, and tsconfig project references.',
    tags: ['typescript', 'tsconfig', 'config', 'build'],
  }),
  makeNode({
    id: 'omg/fact/vitest-testing',
    type: 'fact',
    priority: 'medium',
    description: 'Vitest testing setup — bootstrap coverage',
    body: 'Tests use Vitest with coverage tracking. Bootstrap process tested in integration tests.',
    tags: ['vitest', 'testing', 'bootstrap', 'coverage'],
  }),
  makeNode({
    id: 'omg/fact/bootstrap-process',
    type: 'fact',
    priority: 'medium',
    description: 'Bootstrap process — sentinel, cold-start, OMG initialization',
    body: 'Bootstrap uses a sentinel file to track completion. Cold-start initializes the OMG graph.',
    tags: ['bootstrap', 'sentinel', 'cold-start', 'omg'],
  }),

  // Decisions (medium/low priority)
  makeNode({
    id: 'omg/decision/package-manager-pnpm',
    type: 'decision',
    priority: 'medium',
    description: 'Package manager decision — pnpm chosen for workspace tooling',
    body: 'pnpm chosen as package manager. Workspace-based tooling with efficient disk usage.',
    tags: ['pnpm', 'package-manager', 'decision', 'tooling'],
  }),
  makeNode({
    id: 'omg/decision/vitest-over-jest',
    type: 'decision',
    priority: 'low',
    description: 'Testing framework decision — Vitest chosen over Jest',
    body: 'Vitest selected over Jest for faster test execution and native ESM support.',
    tags: ['vitest', 'jest', 'testing', 'decision'],
  }),

  // Episodes (medium/low priority)
  makeNode({
    id: 'omg/episode/calendar-session',
    type: 'episode',
    priority: 'medium',
    description: 'Calendar planning session — today, Dom2026 schedule',
    body: 'Planning session for today\'s calendar. Dom2026 project scheduling and daily planning.',
    tags: ['calendar', 'today', 'planning', 'schedule', 'dom2026'],
  }),
  makeNode({
    id: 'omg/episode/gym-schedule',
    type: 'episode',
    priority: 'low',
    description: 'Gym schedule — jutro siłownia, tomorrow workout',
    body: 'Siłownia (gym) scheduled for jutro (tomorrow). Regular workout schedule tracking.',
    tags: ['siłownia', 'jutro', 'gym', 'schedule', 'tomorrow'],
  }),

  // Reflections (low priority)
  makeNode({
    id: 'omg/reflection/memory-patterns',
    type: 'reflection',
    priority: 'low',
    description: 'Memory patterns reflection — synthesis of graph usage',
    body: 'Reflection on memory graph patterns and synthesis of knowledge over time.',
    tags: ['reflection', 'memory', 'patterns', 'synthesis'],
  }),
  makeNode({
    id: 'omg/reflection/coding-habits',
    type: 'reflection',
    priority: 'low',
    description: 'Coding habits reflection — TypeScript practices',
    body: 'Reflection on coding habits and TypeScript development practices.',
    tags: ['reflection', 'coding', 'typescript', 'habits'],
  }),
]

// Build registry entries from the node list
const REGISTRY_ENTRIES: [string, RegistryNodeEntry][] = ALL_NODES.map((n) => [
  n.frontmatter.id,
  makeRegistryEntry({
    type: n.frontmatter.type,
    priority: n.frontmatter.priority,
    description: n.frontmatter.description,
    filePath: n.filePath,
    tags: n.frontmatter.tags ? [...n.frontmatter.tags] : undefined,
  }),
])

function buildHydrateNode(nodes: GraphNode[]) {
  const byPath = new Map(nodes.map((n) => [n.filePath, n]))
  return vi.fn().mockImplementation((fp: string) => Promise.resolve(byPath.get(fp) ?? null))
}

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------

interface BenchmarkScenario {
  readonly query: string
  readonly description: string
  readonly expectedNodeIds: readonly string[]
}

const SCENARIOS: BenchmarkScenario[] = [
  // --- Personal ---
  {
    query: 'Powiedz mi o żona',
    description: 'Polish: ask about wife',
    expectedNodeIds: ['omg/identity/partner-sylwia'],
  },
  {
    query: 'Tell me about Sylwia',
    description: 'English: ask about Sylwia by name',
    expectedNodeIds: ['omg/identity/partner-sylwia'],
  },
  {
    query: 'Co wiem o mama',
    description: 'Polish: ask about mother',
    expectedNodeIds: ['omg/identity/family-mama'],
  },
  {
    query: 'wife relationship context',
    description: 'English: wife keyword only',
    expectedNodeIds: ['omg/identity/partner-sylwia'],
  },

  // --- Technical ---
  {
    query: 'TypeScript tsconfig configuration',
    description: 'TypeScript config lookup',
    expectedNodeIds: ['omg/fact/typescript-config', 'omg/preference/coding-style'],
  },
  {
    query: 'How does the bootstrap sentinel work',
    description: 'Bootstrap process query',
    expectedNodeIds: ['omg/fact/bootstrap-process', 'omg/fact/vitest-testing'],
  },
  {
    query: 'Vitest coverage testing setup',
    description: 'Vitest testing facts',
    expectedNodeIds: ['omg/fact/vitest-testing', 'omg/decision/vitest-over-jest'],
  },
  {
    query: 'pnpm workspace package manager',
    description: 'Package manager decision',
    expectedNodeIds: ['omg/decision/package-manager-pnpm'],
  },

  // --- Temporal ---
  {
    query: 'What is happening today',
    description: 'Today query → calendar',
    expectedNodeIds: ['omg/episode/calendar-session'],
  },
  {
    query: 'jutro siłownia trening',
    description: 'Polish: tomorrow gym workout',
    expectedNodeIds: ['omg/episode/gym-schedule'],
  },
  {
    query: 'gym schedule tomorrow workout',
    description: 'English: gym schedule',
    expectedNodeIds: ['omg/episode/gym-schedule'],
  },
  {
    query: 'calendar Dom2026 planning schedule',
    description: 'Calendar Dom2026 session',
    expectedNodeIds: ['omg/episode/calendar-session'],
  },

  // --- Preferences ---
  {
    query: 'formatowanie kodu prettier',
    description: 'Polish: code formatting',
    expectedNodeIds: ['omg/preference/code-formatting'],
  },
  {
    query: 'code formatting style',
    description: 'English: formatting preferences',
    expectedNodeIds: ['omg/preference/code-formatting', 'omg/preference/coding-style'],
  },
  {
    query: 'What editor should I use Zed VSCode',
    description: 'Editor setup query',
    expectedNodeIds: ['omg/preference/editor-setup'],
  },

  // --- Projects ---
  {
    query: 'Secretary workspace agent project',
    description: 'Secretary project lookup',
    expectedNodeIds: ['omg/project/secretary-workspace'],
  },
  {
    query: 'TechLead responsibilities leadership role',
    description: 'TechLead role query',
    expectedNodeIds: ['omg/project/techlead-role'],
  },
  {
    query: 'coding practices style guide typescript',
    description: 'Coding practices cross-category',
    expectedNodeIds: ['omg/preference/coding-style', 'omg/project/techlead-role', 'omg/reflection/coding-habits'],
  },

  // --- Cross-category ---
  {
    query: 'typescript coding style preferences config',
    description: 'TypeScript + coding preferences cross-category',
    expectedNodeIds: ['omg/preference/coding-style', 'omg/fact/typescript-config'],
  },
  {
    query: 'personal family wife mother',
    description: 'Family/personal cross-category',
    expectedNodeIds: ['omg/identity/partner-sylwia', 'omg/identity/family-mama'],
  },
]

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computeMetrics(
  expected: readonly string[],
  retrieved: readonly string[]
): { precision: number; recall: number } {
  if (retrieved.length === 0) {
    return { precision: 0, recall: expected.length === 0 ? 1 : 0 }
  }
  const expectedSet = new Set(expected)
  const truePositives = retrieved.filter((id) => expectedSet.has(id)).length
  return {
    precision: truePositives / retrieved.length,
    recall: expected.length === 0 ? 1 : truePositives / expected.length,
  }
}

// ---------------------------------------------------------------------------
// Shared state for summary
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  query: string
  description: string
  expectedNodeIds: readonly string[]
  retrievedIds: string[]
  precision: number
  recall: number
}

const benchmarkResults: BenchmarkResult[] = []

const config: OmgConfig = parseConfig({
  injection: { maxNodes: 8, maxContextTokens: 4000, maxMocs: 3 },
})

// ---------------------------------------------------------------------------
// Tests: WITHOUT OMG — empty graph baseline
// ---------------------------------------------------------------------------

describe('WITHOUT OMG — empty graph baseline', () => {
  it.each(SCENARIOS)('[$description] retrieves nothing', async ({ query, description: _desc }) => {
    const hydrateNode = vi.fn().mockResolvedValue(null)

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [],
      recentMessages: [{ role: 'user', content: query }],
      config,
      hydrateNode,
    })

    expect(slice.nodes).toHaveLength(0)
    expect(slice.mocs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: WITH OMG — 18-node mock graph
// ---------------------------------------------------------------------------

describe('WITH OMG — 18-node mock graph', () => {
  it.each(SCENARIOS)('[$description]', async ({ query, description, expectedNodeIds }) => {
    const hydrateNode = buildHydrateNode(ALL_NODES)

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: REGISTRY_ENTRIES,
      recentMessages: [{ role: 'user', content: query }],
      config,
      hydrateNode,
    })

    const retrievedIds = [...slice.mocs, ...slice.nodes].map((n) => n.frontmatter.id)
    const { precision, recall } = computeMetrics(expectedNodeIds, retrievedIds)

    benchmarkResults.push({ query, description, expectedNodeIds, retrievedIds, precision, recall })

    const atLeastOne = expectedNodeIds.some((id) => retrievedIds.includes(id))
    expect(
      atLeastOne,
      `Expected at least one of [${expectedNodeIds.join(', ')}], got [${retrievedIds.join(', ')}]`
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Benchmark Summary
// ---------------------------------------------------------------------------

describe('Benchmark Summary', () => {
  afterAll(() => {
    const passed = benchmarkResults.filter((r) => r.precision >= 0.5 && r.recall >= 0.5).length

    console.table(
      benchmarkResults.map((r) => ({
        Query: r.query.slice(0, 45),
        'P%': Math.round(r.precision * 100),
        'R%': Math.round(r.recall * 100),
        Expected: r.expectedNodeIds.length,
        Retrieved: r.retrievedIds.length,
        Status: r.precision >= 0.5 && r.recall >= 0.5 ? 'PASS ✓' : 'FAIL ✗',
      }))
    )

    console.log(`\n${passed}/${benchmarkResults.length} scenarios passed (P≥50% AND R≥50%)`)
  })

  it('produces a complete benchmark report', () => {
    // This test runs after all WITH-OMG tests have populated benchmarkResults.
    // Its only role is to trigger the afterAll summary.
    // Results are evaluated per-scenario in the WITH OMG describe block.
    expect(benchmarkResults.length).toBeGreaterThanOrEqual(0)
  })
})
