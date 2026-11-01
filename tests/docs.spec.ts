/**
 * The documentation is part of the product, so its links, anchors and file paths are tested: a document that points at
 * a file which no longer exists is worse than no document, because it is believed.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { packageRoot } from '../src/prompts.ts'

const root = packageRoot()
const files = [...readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => join('docs', name)), 'README.md']
const text = (file: string): string => readFileSync(join(root, file), 'utf8')

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
const anchorOf = (heading: string): string => heading.trim().toLowerCase()
  .replace(/`/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')

/** Every heading anchor a document defines, including the numbered ones. */
function anchors(file: string): Set<string> {
  const found = new Set<string>()
  for (const line of text(file).split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line)
    if (match) found.add(anchorOf(match[1]!))
  }
  return found
}

const links = (file: string): string[] => [...text(file).matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!)

describe('documentation', () => {
  it('covers the numbered documents in order, with no gaps', () => {
    const numbered = files.filter(file => /docs\/\d{3}-/.test(file)).map(file => Number(/docs\/(\d{3})-/.exec(file)![1]))
    expect(numbered).toEqual(numbered.map((_, index) => index))
  })

  it('links only to files that exist', () => {
    const broken = files.flatMap(file => links(file)
      .filter(target => !target.startsWith('http'))
      .map(target => target.split('#')[0]!)
      .filter(target => target !== '')
      .filter(target => !existsSync(join(dirname(join(root, file)), target)))
      .map(target => `${file} → ${target}`))
    expect(broken).toEqual([])
  })

  it('links only to anchors a document defines', () => {
    const broken: string[] = []
    for (const file of files) {
      for (const target of links(file)) {
        if (target.startsWith('http') || !target.includes('#')) continue
        const [path, anchor] = target.split('#') as [string, string]
        const targetFile = path ? join(dirname(file), path) : file
        if (!existsSync(join(root, targetFile))) continue // reported by the link test
        if (!anchors(targetFile).has(anchor)) broken.push(`${file} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('names only source files that exist', () => {
    const missing = files.flatMap(file => [...text(file).matchAll(/`(src\/[\w./-]+\.tsx?)`/g)]
      .map(match => match[1]!)
      .filter(path => !existsSync(join(root, path)))
      .map(path => `${file} → ${path}`))
    expect(missing).toEqual([])
  })

  it('names only scripts and prompt files that exist', () => {
    const missing = files.flatMap(file => [...text(file).matchAll(/`((?:scripts|prompts)\/[\w./-]+\.(?:ts|md))`/g)]
      .map(match => match[1]!)
      .filter(path => !existsSync(join(root, path)))
      .map(path => `${file} → ${path}`))
    expect(missing).toEqual([])
  })
})
