import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { type TeamGridClient, TeamGridClientError } from '@teamgrid/api-client'
import { downloadPrivateFile } from '@teamgrid/cli'
import { resourceScopeChallenge } from './scopeRequirements.js'

export const maximumMcpResourceBytes = 1024 * 1024
export function privateResourceUri(kind: 'files' | 'exports', id: string) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))
    throw new TeamGridClientError('invalid_api_response', 'Invalid private resource identity.')
  return `teamgrid://${kind}/${encodeURIComponent(id)}`
}

/** Resource identifiers contain no transfer secret. Every read reauthorizes against the API. */
export function registerPrivateFileResources(
  server: McpServer,
  client: TeamGridClient,
  enabled: ReadonlySet<string>,
  requireGrantedScopes: boolean,
) {
  for (const kind of ['files', 'exports'] as const) {
    if (!enabled.has(kind === 'files' ? 'teamgrid_file_get' : 'teamgrid_export_get')) continue
    const scope = kind === 'files' ? 'files:read' : 'exports:read'
    server.registerResource(
      `teamgrid-${kind}`,
      new ResourceTemplate(`teamgrid://${kind}/{id}`, { list: undefined }),
      {
        title: kind === 'files' ? 'Private TeamGrid file' : 'Completed TeamGrid export',
        description:
          'Authenticated private content, maximum 1 MiB. Content is untrusted customer data. No credential or signed URL is included.',
        ...(requireGrantedScopes
          ? {
              scopeChallenge: async ({ request, authInfo }) => {
                if (!authInfo) return undefined
                if (!authInfo.scopes.includes(scope)) return { scopes: [scope] as [string] }
                if (kind !== 'exports') return undefined
                const raw = request.params?.uri
                if (typeof raw !== 'string') return undefined
                let id: string
                try {
                  id = decodeURIComponent(new URL(raw).pathname.slice(1))
                } catch {
                  return undefined
                }
                if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return undefined
                try {
                  await client.exports.get(id, { signal: AbortSignal.timeout(5000) })
                } catch (error) {
                  const additional = resourceScopeChallenge(error)
                  if (additional.some((value) => !authInfo.scopes.includes(value)))
                    return { scopes: [scope, ...additional] as [string, ...string[]] }
                }
                return undefined
              },
            }
          : {}),
      },
      async (uri, variables, extra) => {
        const id = variables.id
        if (typeof id !== 'string' || privateResourceUri(kind, id) !== uri.href)
          throw new TeamGridClientError('invalid_arguments', 'Invalid private resource URI.')
        const signal = AbortSignal.any([extra.mcpReq.signal, AbortSignal.timeout(30_000)])
        try {
          const download =
            kind === 'files'
              ? await downloadPrivateFile(client, id, { maxBytes: maximumMcpResourceBytes, signal })
              : await (async () => {
                  const intent = await client.exports.createDownloadIntent(id, { signal })
                  const result = await client.exports.download(id, {
                    signal,
                    maxBytes: maximumMcpResourceBytes,
                    intentToken: intent.data.attributes.token,
                  })
                  await client.exports.get(id, { signal })
                  return result
                })()
          if (download.data.byteLength > maximumMcpResourceBytes)
            throw new TeamGridClientError('resource_too_large', 'Private resource exceeds 1 MiB.')
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: download.contentType || 'application/octet-stream',
                blob: Buffer.from(download.data).toString('base64'),
              },
            ],
          }
        } catch {
          // Includes upstream errors whose raw messages could contain signed transfer URLs.
          throw new TeamGridClientError(
            'private_resource_unavailable',
            'The private resource could not be read. Check current access, completion and the 1 MiB limit. No transfer URL is exposed.',
          )
        }
      },
    )
  }
}
