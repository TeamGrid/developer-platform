function coreParts(version) {
  const parts = String(version).split('-')[0].split('.').map(Number)
  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return undefined
  }
  return parts
}

export function isReleaseCompatibleWithContract(releaseVersion, contractVersion) {
  const release = coreParts(releaseVersion)
  const contract = coreParts(contractVersion)
  if (!release || !contract) return false

  return (
    release[0] === contract[0] &&
    release[1] === contract[1] &&
    release[2] >= contract[2]
  )
}
