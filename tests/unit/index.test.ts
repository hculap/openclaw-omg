import { describe, it, expect } from 'vitest'
import * as publicApi from '../../src/index.js'

describe('src/index.ts public API surface', () => {
  it('exports all expected value symbols', () => {
    const expectedValues = [
      'parseConfig',
      'omgConfigSchema',
      'ConfigValidationError',
      'NODE_TYPES',
      'PRIORITY_ORDER',
      'isNodeType',
      'isCompressionLevel',
      'ReflectorInvariantError',
      'createReflectorOutput',
      'OmgSessionStateError',
      'createOmgSessionState',
      'parseNodeFrontmatter',
      'nodeFrontmatterSchema',
      'FrontmatterValidationError',
      'scaffoldGraphIfNeeded',
      'beforeCompaction',
      'plugin',
    ]
    for (const name of expectedValues) {
      expect(publicApi, `expected "${name}" to be exported`).toHaveProperty(name)
    }
  })
})
