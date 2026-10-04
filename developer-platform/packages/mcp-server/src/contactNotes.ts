import { projectDocumentContent } from './documentContent.js'

/** Continuations re-read the same authorized contact and require its exact ETag. */
export function projectContactNotes(data: unknown, input: Record<string, unknown>, etag?: string) {
  if (!data || typeof data !== 'object' || !('attributes' in data)) return { data, meta: {} }
  const { notes, ...attributes } = data.attributes as Record<string, unknown>
  if (typeof notes !== 'string') return { data, meta: {} }
  const page = projectDocumentContent(
    { ...data, attributes: { ...attributes, content: notes } },
    {
      contentOffset: input.notesOffset,
      contentLimit: input.notesLimit,
      expectedRevision: input.expectedRevision,
    },
    etag,
    false,
  )
  const { content, ...metadata } = (page.data as { attributes: Record<string, unknown> }).attributes
  return {
    data: { ...data, attributes: { ...metadata, notes: content } },
    meta: { notesPage: page.meta.contentPage },
  }
}
