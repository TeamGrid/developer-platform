import { describe, expect, it, vi } from 'vitest'
import { downloadPrivateFile, privateTransferUrl, publicTransferAddress } from './fileTransfer.js'

function setup() {
  const transfer = {
    method: 'GET',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    headers: {},
    url: 'https://files.example.test/private?signature=secret-canary',
  }
  const client = {
    files: {
      createDownloadIntent: vi.fn(async () => ({
        data: {
          attributes: { transfer, file: { fileName: 'test.txt', mimeType: 'text/plain', size: 4 } },
        },
      })),
      get: vi.fn(async () => ({
        data: { attributes: { downloadAvailable: true, blocked: false, size: 4 } },
      })),
    },
  }
  const fetchBytes = vi.fn(async () => new Uint8Array([84, 101, 115, 116]))
  return { client, transfer, fetchBytes }
}
describe('private file delivery', () => {
  it('returns only bytes and metadata, then rechecks current authority', async () => {
    const h = setup()
    const result = await downloadPrivateFile(h.client as never, 'file1', {
      fetchBytes: h.fetchBytes,
    })
    expect(result).toEqual({
      data: new Uint8Array([84, 101, 115, 116]),
      fileName: 'test.txt',
      contentType: 'text/plain',
    })
    expect(JSON.stringify(result)).not.toContain('signature')
    expect(h.client.files.get).toHaveBeenCalledOnce()
  })
  it('rejects size before network, truncated bytes, expired intents and revoked access', async () => {
    const h = setup()
    await expect(
      downloadPrivateFile(h.client as never, 'file1', { maxBytes: 3, fetchBytes: h.fetchBytes }),
    ).rejects.toMatchObject({ code: 'file_transfer_too_large' })
    expect(h.fetchBytes).not.toHaveBeenCalled()
    h.fetchBytes.mockResolvedValueOnce(new Uint8Array([1]))
    await expect(
      downloadPrivateFile(h.client as never, 'file1', { fetchBytes: h.fetchBytes }),
    ).rejects.toMatchObject({ code: 'file_transfer_failed' })
    h.client.files.get.mockRejectedValueOnce(new Error('private?signature=secret-canary'))
    await expect(
      downloadPrivateFile(h.client as never, 'file1', { fetchBytes: h.fetchBytes }),
    ).rejects.not.toThrow('secret-canary')
    h.transfer.expiresAt = new Date(0).toISOString()
    h.fetchBytes.mockClear()
    await expect(
      downloadPrivateFile(h.client as never, 'file1', { fetchBytes: h.fetchBytes }),
    ).rejects.toThrow()
    expect(h.fetchBytes).not.toHaveBeenCalled()
  })
  it('rejects unsafe transfer URLs, private DNS and address translation', () => {
    for (const url of [
      'http://files.example.test/file',
      'https://user:pass@files.example.test/file',
      'https://127.0.0.1/file',
      'https://[::1]/file',
      'https://files.example.test:444/file',
      'https://files.example.test/file#fragment',
    ])
      expect(() => privateTransferUrl(url)).toThrow()
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      '2001:db8::1',
    ])
      expect(publicTransferAddress(address)).toBe(false)
    expect(publicTransferAddress('1.1.1.1')).toBe(true)
    expect(publicTransferAddress('2606:4700:4700::1111')).toBe(true)
  })
})
