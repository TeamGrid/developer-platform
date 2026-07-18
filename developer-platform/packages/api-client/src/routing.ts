import { TeamGridClientError } from './errors.js'

const tokenPattern = /^tg_sk_v1_([a-z0-9-]+)_([a-z0-9-]+)_([a-f0-9]{24})_([a-f0-9]{64})$/
const locationPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export type CredentialLocation = Readonly<{
  cellId: string
  credentialId: string
  region: string
}>

export function parseCredentialLocation(token: string): CredentialLocation {
  const match = tokenPattern.exec(String(token || '').trim())
  if (!match) {
    throw new TeamGridClientError(
      'invalid_credential',
      'Expected a TeamGrid Developer Platform credential in tg_sk_v1_… format.',
    )
  }
  const region = match[1]
  const cellId = match[2]
  const credentialId = match[3]
  if (
    !region ||
    !cellId ||
    !credentialId ||
    !locationPattern.test(region) ||
    !locationPattern.test(cellId)
  ) {
    throw new TeamGridClientError('invalid_credential', 'The credential location is invalid.')
  }
  return Object.freeze({ cellId, credentialId, region })
}

export function buildRegionalApiBaseUrl(region: string, apiRootDomain = 'teamgrid.app'): string {
  if (!locationPattern.test(region)) {
    throw new TeamGridClientError('invalid_region', 'The API region is invalid.')
  }
  const root = String(apiRootDomain || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (!/^[a-z0-9.-]+$/.test(root) || root.includes('..')) {
    throw new TeamGridClientError('invalid_api_domain', 'The API root domain is invalid.')
  }
  return `https://api.${region}.${root}/v1`
}

export function normalizeApiBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new TeamGridClientError('invalid_base_url', 'The API base URL is invalid.', {
      cause: error,
    })
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new TeamGridClientError('invalid_base_url', 'The API base URL is invalid.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new TeamGridClientError(
      'insecure_base_url',
      'Plain HTTP is allowed only for loopback development endpoints.',
    )
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1'
  return url.toString().replace(/\/$/, '')
}
