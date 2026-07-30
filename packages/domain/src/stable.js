import { createHash, createHmac } from 'node:crypto'

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function hmacSha256(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex')
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export function immutableCopy(value) {
  return deepFreeze(structuredClone(value))
}
