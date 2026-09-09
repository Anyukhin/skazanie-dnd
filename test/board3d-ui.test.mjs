import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { Fragment, createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createTacticalMap, setCell } from '../server/tactical-map.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-ui-'))
test.after(() => rmSync(buildDir, { recursive: true, force: true }))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sourcePath = fileURLToPath(new URL('../src/TacticalBoard3D.tsx', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--jsx', 'react-jsx', '--resolveJsonModule',
  '--esModuleInterop', '--noUncheckedSideEffectImports', 'false', '--rootDir', root, '--outDir', buildDir, sourcePath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)

function emittedFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? emittedFiles(path) : [path]
  })
}

for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const source = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/gu, (match, prefix, specifier, suffix) => (
      /\.(?:mjs|json)$/u.test(specifier) ? match : `${prefix}${specifier}.mjs${suffix}`
    ))
  const next = path.replace(/\.js$/u, '.mjs')
  writeFileSync(next, source)
  rmSync(path)
}

const { default: TacticalBoard3D } = await import(pathToFileURL(join(buildDir, 'src', 'TacticalBoard3D.mjs')).href)

function mapForUi(width = 20, height = 20) {
  const map = createTacticalMap({ width, height, locationId: 'board3d-ui', seed: 'board3d-ui' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
  }
  setCell(map, width - 1, height - 1, { passable: true, revealed: false })
  return map
}

function cell(x, y, patch = {}) {
  return { x, y, className: '', interactive: false, ...patch }
}

function renderBoard(cells) {
  return renderToStaticMarkup(h(TacticalBoard3D, {
    map: mapForUi(), campaignId: 'board3d-ui', columns: 20, rows: 20, irregular: false,
    ariaLabel: 'Поле боя 3D', themeKey: 'map-theme-interior', artUrl: null,
    cells, overlayCells: [], effectRenderers: [], battleLog: [], visualBatch: null,
    animationActors: [], animationsEnabled: false, conditions: {}, onUnavailable: () => {},
  }))
}

test('SSR не создаёт DOM-обёртки для пустых клеток и сохраняет полезные слои', () => {
  const emptyCells = Array.from({ length: 400 }, (_, index) => {
    const x = index % 20, y = Math.floor(index / 20)
    const children = index % 3 === 0
      ? null
      : index % 3 === 1
        ? false
        : h(Fragment, null, h(Fragment, null, null, false, ''))
    return cell(x, y, { interactive: true, ariaLabel: `Пустая клетка ${x},${y}`, children })
  })
  const actor = cell(1, 1, {
    className: 'occupied-by-hero',
    children: h('button', { type: 'button', className: 'map-token hero-token', 'aria-label': 'Искра' }, 'Искра'),
  })
  const route = cell(2, 1, {
    children: h(Fragment, null, h(Fragment, null, h('span', { className: 'route-step-badge', 'aria-hidden': 'true' }, '1'))),
  })
  const feedback = cell(3, 1, {
    children: h(Fragment, null, h('span', { className: 'map-feedback hit' }, 'Попадание')),
  })
  const loot = cell(4, 1, {
    children: h('span', { className: 'loot-cell-mark kind-cache' }, h('button', {
      type: 'button', className: 'loot-pin', 'aria-label': 'Сундук: 1 предмет', title: 'Сундук: 1 предмет',
    }, h('i', null, '1'))),
    hotspot: h(Fragment, null,
      h('span', { role: 'button', tabIndex: 0, className: 'scene-object-hotspot', 'aria-label': 'Сундук' }),
      h('div', { className: 'scene-object-menu', role: 'group', 'aria-label': 'Действия: Сундук' },
        h('button', { type: 'button', className: 'scene-object-menu-action' }, 'Открыть')),
    ),
  })
  const hidden = cell(19, 19, {
    children: h('button', { type: 'button', className: 'map-token hero-token', 'aria-label': 'Скрытый герой' }, 'Скрытый герой'),
  })
  const markup = renderBoard([...emptyCells, actor, route, feedback, loot, hidden])

  assert.equal((markup.match(/class="board3d-cell\b/gu) ?? []).length, 4)
  assert.equal((markup.match(/data-board3d-cell=/gu) ?? []).length, 4)
  assert.match(markup, /Искра/u)
  assert.match(markup, /aria-label="Искра"/u)
  assert.match(markup, /route-step-badge/u)
  assert.match(markup, /Попадание/u)
  assert.match(markup, /scene-object-menu/u)
  assert.match(markup, /scene-object-hotspot/u)
  assert.match(markup, /aria-label="Сундук"/u)
  assert.match(markup, /loot-pin/u)
  assert.match(markup, /aria-label="Сундук: 1 предмет"/u)
  assert.doesNotMatch(markup, /Скрытый герой/u)
})

test('SSR скрывает FPS по умолчанию и уважает сохранённую настройку', () => {
  const previousStorage = globalThis.localStorage
  try {
    delete globalThis.localStorage
    const off = renderBoard([])
    assert.match(off, />FPS<\/button>/u)
    assert.match(off, /aria-label="Показывать FPS"/u)
    assert.match(off, /aria-pressed="false"/u)
    assert.doesNotMatch(off, /Частота кадров/u)

    globalThis.localStorage = {
      getItem: (key) => key === 'skazanie-3d-fps' ? 'true' : null,
      setItem: () => {},
    }
    const on = renderBoard([])
    assert.match(on, /aria-label="Показывать FPS"/u)
    assert.match(on, /aria-pressed="true"/u)
    assert.match(on, /aria-label="Частота кадров"/u)
    assert.match(on, /aria-live="off"/u)
    assert.match(on, /— FPS/u)
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
