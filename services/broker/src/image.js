export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024

function starts(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value)
}

export function sniffImageType(bytes) {
  if (bytes.length >= 8 && starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (bytes.length >= 3 && starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    starts(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }
  return null
}

export async function readBoundedBody(request, maxBytes = MAX_SOURCE_BYTES) {
  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error(`Asset exceeds ${maxBytes} bytes`)
    error.code = 'ASSET_TOO_LARGE'
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error(`Asset exceeds ${maxBytes} bytes`)
      error.code = 'ASSET_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) {
    const error = new Error('Asset body is empty')
    error.code = 'EMPTY_ASSET'
    throw error
  }
  return Buffer.concat(chunks, size)
}
