import { describe, expect, it } from 'vitest'

import { isReleaseCompatibleWithContract } from './release-version.mjs'

describe('release and contract version compatibility', () => {
  it('allows a package patch release for an unchanged stable contract', () => {
    expect(isReleaseCompatibleWithContract('1.0.1', '1.0.0')).toBe(true)
  })

  it('allows an exact version and a prerelease of a compatible patch', () => {
    expect(isReleaseCompatibleWithContract('1.0.0', '1.0.0')).toBe(true)
    expect(isReleaseCompatibleWithContract('1.0.1-beta.1', '1.0.0')).toBe(true)
  })

  it('rejects older, cross-minor, cross-major, and malformed releases', () => {
    expect(isReleaseCompatibleWithContract('1.0.0', '1.0.1')).toBe(false)
    expect(isReleaseCompatibleWithContract('1.1.0', '1.0.0')).toBe(false)
    expect(isReleaseCompatibleWithContract('2.0.0', '1.0.0')).toBe(false)
    expect(isReleaseCompatibleWithContract('1.0', '1.0.0')).toBe(false)
  })
})
