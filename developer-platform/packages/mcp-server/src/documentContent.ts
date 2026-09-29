import { TeamGridClientError } from '@teamgrid/api-client'

/** Stateless continuation reauthorizes and checks the same document on every read. */
export function projectDocumentContent(
  data: unknown,
  input: Record<string, unknown>,
  etag: string | undefined,
  write: boolean,
) {
  if (!data || typeof data !== 'object' || !('attributes' in data)) return { data, meta: {} }
  const attributes = data.attributes as Record<string, unknown>
  if (typeof attributes.content !== 'string') return { data, meta: {} }
  const { content, ...metadata } = attributes
  if (write)
    return {
      data: { ...data, attributes: metadata },
      meta: {
        outcome: 'completed',
        omittedFields: ['content'],
        contentReadTool: 'teamgrid_document_get',
      },
    }
  const offset = Number(input.contentOffset ?? 0)
  const limit = Number(input.contentLimit ?? 16384)
  if (offset > 0 && !input.expectedRevision) {
    throw new TeamGridClientError(
      'revision_required',
      'Continue with the exact meta.etag from the first document chunk.',
    )
  }
  if (input.expectedRevision && input.expectedRevision !== etag) {
    throw new TeamGridClientError(
      'revision_conflict',
      'The document changed. Restart from offset 0 and review the new version.',
    )
  }
  if (
    offset > content.length ||
    (offset > 0 &&
      /[\uDC00-\uDFFF]/.test(content[offset] ?? '') &&
      /[\uD800-\uDBFF]/.test(content[offset - 1] ?? ''))
  ) {
    throw new TeamGridClientError(
      'invalid_content_offset',
      'Use the returned nextOffset without modification.',
    )
  }
  let end = Math.min(offset + limit, content.length)
  if (
    end < content.length &&
    /[\uD800-\uDBFF]/.test(content[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(content[end] ?? '')
  ) {
    end = end - 1 > offset ? end - 1 : end + 1
  }
  return {
    data: { ...data, attributes: { ...metadata, content: content.slice(offset, end) } },
    meta: {
      contentPage: {
        unit: 'utf16',
        offset,
        nextOffset: end < content.length ? end : null,
        totalLength: content.length,
        complete: offset === 0 && end === content.length,
        revision: etag ?? null,
      },
    },
  }
}
