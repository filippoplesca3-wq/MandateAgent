import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function usedKeys(): string[] {
  const pattern = /process\.env(?:\[["']([A-Z0-9_]+)["']\]|\.([A-Z0-9_]+))/g
  const keys = new Set<string>()

  for (const path of [...walk("src"), ...walk("scripts")]) {
    if (!path.endsWith(".ts")) continue
    const source = readFileSync(path, "utf8")
    for (const match of source.matchAll(pattern)) {
      const key = match[1] ?? match[2]
      if (key) keys.add(key)
    }
  }

  return [...keys].sort()
}

describe(".env.example", () => {
  it("documents every environment variable the code reads", () => {
    const example = readFileSync(".env.example", "utf8")
    const missing = usedKeys().filter((key) => !new RegExp(`^\\s*#?\\s*${key}=`, "m").test(example))

    expect(missing, `missing from .env.example: ${missing.join(", ")}`).toEqual([])
  })
})
