import { describe, it, expect } from "vitest"
import { canonicalize } from "../src/core/canonical.js"

describe("canonicalize", () => {
  it("is independent of object key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } }
    const b = { c: { y: [3, 2, 1], z: 1 }, a: 2, b: 1 }
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it("preserves array order, because order is meaningful", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]))
  })

  it("drops undefined so absent and explicitly-undefined hash identically", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }))
  })

  it("serializes dates as ISO strings", () => {
    const at = new Date("2026-01-01T00:00:00.000Z")
    expect(canonicalize({ at })).toBe('{"at":"2026-01-01T00:00:00.000Z"}')
  })

  it("handles null and primitives", () => {
    expect(canonicalize(null)).toBe("null")
    expect(canonicalize(42)).toBe("42")
    expect(canonicalize("x")).toBe('"x"')
  })

  it("survives a JSON round-trip unchanged", () => {
    const value = { z: 1, a: { m: [1, { q: true }], b: null }, k: "v" }
    const roundTripped = JSON.parse(JSON.stringify(value))
    expect(canonicalize(roundTripped)).toBe(canonicalize(value))
  })
})
