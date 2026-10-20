/**
 * Deterministic JSON serialization.
 *
 * Signatures are computed over a byte string, so the bytes must be identical
 * every time for the same logical value. Plain `JSON.stringify` preserves
 * insertion order, which means a value that round-trips through a database or
 * a network hop can serialize differently and silently break verification.
 *
 * `canonicalize` fixes this by sorting object keys recursively. Array order is
 * preserved, because array order is meaningful.
 */

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalForm(value))
}

function canonicalForm(value: unknown): unknown {
  if (value === null) return null

  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalForm(item)))
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      // `undefined` is dropped, matching JSON.stringify semantics, so that an
      // explicitly-undefined optional field and an absent one hash the same.
      if (item === undefined) continue
      out[key] = canonicalForm(item)
    }
    return out
  }

  return value
}
