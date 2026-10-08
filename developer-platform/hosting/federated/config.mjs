import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { parseMcpHostClients } from '../../packages/mcp-server/dist/index.js'

const unavailable = () => {
  throw new Error('Federated configuration unavailable.')
}
function object(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    unavailable()
}
function text(value, pattern, max = 2048) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) unavailable()
  return value
}
const secret = (value) => text(value, /^[A-Za-z0-9_-]{32,256}$/, 256)
// Existing regional API origin credentials use bounded visible ASCII, including base64.
const originSecret = (value) => text(value, /^[\x21-\x7e]{32,512}$/, 512)
const flag = (value) => {
  if (typeof value !== 'boolean') unavailable()
  return value
}
function https(value, root = false) {
  text(value, /^https:\/\//)
  const url = new URL(value)
  if (
    url.href !== value ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (root && url.pathname !== '/')
  )
    unavailable()
  return url
}
const filePath = (value) => {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)) unavailable()
  return value
}
function quota(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60000) unavailable()
  return value
}

/** Bounded regular files only. Production service requires Unix ownership/permissions. */
export function readPrivateJson(path, maxBytes = 65536) {
  filePath(path)
  if (process.platform === 'win32') unavailable()
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > maxBytes ||
      (info.mode & 0o077) !== 0 ||
      ![0, process.getuid()].includes(info.uid)
    )
      unavailable()
    const bytes = Buffer.alloc(maxBytes + 1)
    let size = 0,
      count = 0
    do {
      count = readSync(fd, bytes, size, bytes.length - size, null)
      size += count
    } while (count > 0 && size < bytes.length)
    if (size > maxBytes) unavailable()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } catch {
    return unavailable()
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function parseServiceConfig(input) {
  try {
    object(input, [
      'version',
      'issuer',
      'resource',
      'enabled',
      'writesEnabled',
      'selectionUiOrigin',
      'workspaceRootDomain',
      'workspaceUiMode',
      'selectionServiceSecret',
      'cells',
      'clientPolicyFile',
      'oidcKeyFile',
      'mongo',
      'admission',
      'allowedOrigins',
      'hostClients',
      'listen',
    ])
    if (input.version !== 1) unavailable()
    const issuer = https(input.issuer, true),
      resource = https(input.resource)
    if (resource.origin !== issuer.origin || resource.pathname !== '/mcp') unavailable()
    const selectionUiOrigin = https(input.selectionUiOrigin, true).href
    const workspaceRootDomain = text(input.workspaceRootDomain, /^[a-z0-9.-]+$/, 253)
    if (
      input.workspaceUiMode !== undefined &&
      !['subdomain', 'path'].includes(input.workspaceUiMode)
    )
      unavailable()
    const domain = new URL(`https://${workspaceRootDomain}/`)
    if (
      domain.hostname !== workspaceRootDomain ||
      !workspaceRootDomain.includes('.') ||
      isIP(workspaceRootDomain) ||
      workspaceRootDomain
        .split('.')
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      unavailable()
    if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > 16)
      unavailable()
    const cells = input.cells.map((cell) => {
      object(cell, [
        'region',
        'cellId',
        'providerUrl',
        'serviceSecret',
        'apiBaseUrl',
        'apiOriginSecret',
      ])
      const provider = https(cell.providerUrl),
        api = https(cell.apiBaseUrl)
      if (
        !/^\/internal\/developer\/oauth\/integrations\/(?!regional\/)[a-z][a-z0-9-]{0,31}\/access$/.test(
          provider.pathname,
        ) ||
        api.pathname !== '/v1'
      )
        unavailable()
      return {
        region: text(cell.region, /^[a-z0-9][a-z0-9-]{0,62}$/),
        cellId: text(cell.cellId, /^[a-z0-9][a-z0-9-]{0,62}$/),
        providerUrl: provider.href,
        serviceSecret: secret(cell.serviceSecret),
        apiBaseUrl: api.href,
        apiOriginSecret: originSecret(cell.apiOriginSecret),
      }
    })
    if (
      new Set(cells.map((cell) => cell.cellId)).size !== cells.length ||
      new Set(cells.map((cell) => cell.providerUrl)).size !== cells.length
    )
      unavailable()
    object(input.mongo, ['uri', 'database'])
    const mongo = {
      uri: text(input.mongo.uri, /^mongodb(?:\+srv)?:\/\//, 8192),
      database: text(input.mongo.database, /^teamgrid_federation_[a-z0-9_]{1,40}$/, 64),
    }
    object(input.admission, [
      'hmacSecret',
      'globalPerMinute',
      'publicPerMinute',
      'credentialPerMinute',
    ])
    const admission = {
      hmacSecret: secret(input.admission.hmacSecret),
      globalPerMinute: quota(input.admission.globalPerMinute),
      publicPerMinute: quota(input.admission.publicPerMinute),
      credentialPerMinute: quota(input.admission.credentialPerMinute),
    }
    const selectionServiceSecret = secret(input.selectionServiceSecret)
    if (
      admission.publicPerMinute > admission.globalPerMinute ||
      admission.credentialPerMinute > admission.globalPerMinute ||
      admission.hmacSecret === selectionServiceSecret ||
      cells.some(
        (cell) =>
          [cell.serviceSecret, cell.apiOriginSecret].includes(admission.hmacSecret) ||
          [cell.serviceSecret, cell.apiOriginSecret].includes(selectionServiceSecret),
      )
    )
      unavailable()
    if (
      !Array.isArray(input.allowedOrigins) ||
      input.allowedOrigins.length > 50 ||
      new Set(input.allowedOrigins).size !== input.allowedOrigins.length
    )
      unavailable()
    const allowedOrigins = input.allowedOrigins.map((origin) => {
      const parsed = https(`${origin}/`, true)
      if (parsed.origin !== origin) unavailable()
      return origin
    })
    object(input.listen, ['host', 'port'])
    if (
      !['127.0.0.1', '0.0.0.0', '::1'].includes(input.listen.host) ||
      !Number.isSafeInteger(input.listen.port) ||
      input.listen.port < 1 ||
      input.listen.port > 65535
    )
      unavailable()
    return {
      version: 1,
      issuer: issuer.href,
      resource: resource.href,
      enabled: flag(input.enabled),
      writesEnabled: flag(input.writesEnabled),
      selectionUiOrigin,
      workspaceRootDomain,
      ...(input.workspaceUiMode === undefined ? {} : { workspaceUiMode: input.workspaceUiMode }),
      selectionServiceSecret,
      cells,
      mongo,
      admission,
      allowedOrigins,
      hostClients: parseMcpHostClients(JSON.stringify(input.hostClients)),
      clientPolicyFile: filePath(input.clientPolicyFile),
      ...(input.oidcKeyFile === undefined ? {} : { oidcKeyFile: filePath(input.oidcKeyFile) }),
      listen: { ...input.listen },
    }
  } catch {
    return unavailable()
  }
}

export function parseClientPolicy(input) {
  try {
    object(input, ['version', 'cimdEnabled', 'cimdAllowedOrigins', 'clients'])
    if (
      input.version !== 1 ||
      !Array.isArray(input.clients) ||
      input.clients.length > 50 ||
      !Array.isArray(input.cimdAllowedOrigins) ||
      input.cimdAllowedOrigins.length > 50 ||
      new Set(input.cimdAllowedOrigins).size !== input.cimdAllowedOrigins.length
    )
      unavailable()
    const cimdEnabled = flag(input.cimdEnabled)
    if (cimdEnabled && input.cimdAllowedOrigins.length < 1) unavailable()
    for (const origin of input.cimdAllowedOrigins) {
      const url = https(`${origin}/`, true)
      if (url.origin !== origin || url.port || isIP(url.hostname.replace(/^\[|\]$/g, '')))
        unavailable()
    }
    return structuredClone({ ...input, cimdEnabled })
  } catch {
    return unavailable()
  }
}

export const immutableConfig = ({ enabled: _enabled, writesEnabled: _writes, ...other }) =>
  JSON.stringify(other)
