// Сторож графа импортов сервера: циклов нет, и пусть так и остаётся.
//
// Замер 2026-10-01: в `server/` нет ни одного цикла статических импортов.
// Это не мелочь — на этом держится порядок инициализации модулей (цикл в ESM
// отдаёт неинициализированную привязку, и константа каталога внезапно
// оказывается `undefined`) и возможность выносить части движка в отдельные
// модули. Отдельные модули уже держат это правило вручную: `law-and-order.mjs`
// намеренно лист, иначе замкнул бы цепочку `merchant-economy` →
// `npc-positioning`. Тест делает правило общим.
//
// Динамический `import()` не считается: он и есть законный способ разорвать
// зависимость, которая нужна только во время исполнения.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const serverDir = join(root, 'server')

function serverModules(directory = serverDir) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return serverModules(path)
    return entry.name.endsWith('.mjs') ? [path] : []
  })
}

/** Статические `import … from` и `export … from` с относительным путём. */
function staticImports(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return [...withoutComments.matchAll(/^\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)]
    .map((match) => match[1])
}

/** Компоненты сильной связности размером больше одного узла (алгоритм Тарьяна). */
function importCycles(graph) {
  let index = 0
  const stack = []
  const onStack = new Set()
  const indices = new Map()
  const lowLinks = new Map()
  const cycles = []
  const visit = (node) => {
    indices.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)))
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)))
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return
    const component = []
    let member
    do {
      member = stack.pop()
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component.sort())
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node)
  return cycles
}

test('в server/ нет циклов статических импортов', () => {
  const graph = new Map()
  for (const path of serverModules()) {
    const name = relative(root, path).replaceAll('\\', '/')
    const targets = staticImports(readFileSync(path, 'utf8'))
      .map((specifier) => relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/'))
      .filter((target) => target.startsWith('server/'))
    graph.set(name, targets)
  }
  assert.ok(graph.size > 100, `сторож нашёл всего ${graph.size} модулей — разбор путей сломан`)
  assert.ok(graph.get('server/rules-engine.mjs')?.length > 10, 'импорты движка не разобраны')
  assert.deepEqual(importCycles(graph), [])
})

test('сторож видит цикл, если он есть', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
    ['d', ['a']],
    ['e', ['e']],
  ])
  assert.deepEqual(importCycles(graph), [['a', 'b', 'c'], ['e']])
})

test('разбор импортов не путает комментарии и динамический import()', () => {
  const source = [
    "import { a } from './a.mjs'",
    "import {",
    "  b,",
    "} from '../server/b.mjs'",
    "export { c } from './c.mjs'",
    "import './side-effect.mjs'",
    "// import { d } from './d.mjs'",
    "const lazy = await import('./lazy.mjs')",
    "import fs from 'node:fs'",
  ].join('\n')
  assert.deepEqual(staticImports(source), ['./a.mjs', '../server/b.mjs', './c.mjs', './side-effect.mjs'])
})
