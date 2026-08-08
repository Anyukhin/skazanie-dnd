#!/usr/bin/env node
// @ts-check
/**
 * Регистрация файла в `data/asset-rights.json`.
 *
 * Каждый файл под `public/assets` обязан быть объявлен: `content-integrity`
 * сверяет дерево с реестром и падает на любом незаявленном или пропавшем файле
 * (`ASSET_REGISTRY_DRIFT`). Атлас предметов пересобирается при каждой правке
 * набора, и хеш при этом меняется, поэтому запись обновляется инструментом, а
 * не руками.
 *
 * Инструмент трогает **только перечисленные пути**. Остальные записи и их
 * порядок остаются как были: в реестре лежат чужие наборы, и переписывать их
 * заодно — не дело инструмента про один файл.
 *
 * Права инструмент не выдаёт. Поля `rights_status` и `distribution` в реестре
 * общие на всё дерево `public/assets` и меняются владельцем осознанно;
 * происхождение набора фиксируется в `docs/map-library.md`.
 *
 * Запуск: node tools/register-asset-rights.mjs maps/props/prop-atlas.png ...
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const REGISTRY = join(ROOT, 'data/asset-rights.json')
const ASSETS = join(ROOT, 'public/assets')

/**
 * Реестр печатается в том же виде, в каком лежит в репозитории: одна запись —
 * одна строка. `JSON.stringify` с отступом разворачивает каждую тройку на пять
 * строк и превращает добавление одного файла в дифф на пять сотен строк.
 *
 * @param {{assets: unknown[][]}} registry
 * @returns {string}
 */
function serializeRegistry(registry) {
  const lines = []
  for (const [key, value] of Object.entries(registry)) {
    if (key === 'assets') {
      lines.push('  "assets": [')
      lines.push(registry.assets.map((tuple) => `    [${tuple.map((value) => JSON.stringify(value)).join(', ')}]`).join(',\n'))
      lines.push('  ],')
      continue
    }
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  }
  const body = lines.join('\n').replace(/,$/u, '')
  return `{\n${body}\n}\n`
}

/**
 * Реестр и корень набора вынесены в параметры не ради гибкости — второго
 * реестра у проекта нет. Ради проверяемости: инструмент, который умеет писать
 * только в настоящий `data/asset-rights.json`, тестируется либо правкой
 * репозитория, либо никак.
 *
 * @param {string[]} paths пути относительно корня набора
 * @param {string} [registryFile]
 * @param {{assetsRoot?: string}} [options]
 * @returns {{added: string[], updated: string[], unchanged: string[]}}
 */
export function registerAssets(paths, registryFile = REGISTRY, { assetsRoot = ASSETS } = {}) {
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
  if (!Array.isArray(registry.assets)) throw new Error('В data/asset-rights.json нет списка assets')
  const report = { added: /** @type {string[]} */ ([]), updated: /** @type {string[]} */ ([]), unchanged: /** @type {string[]} */ ([]) }
  for (const path of paths) {
    const file = join(assetsRoot, path)
    const bytes = readFileSync(file)
    const record = [path, createHash('sha256').update(bytes).digest('hex'), statSync(file).size]
    const at = registry.assets.findIndex((/** @type {unknown[]} */ tuple) => tuple?.[0] === path)
    if (at < 0) {
      registry.assets.push(record)
      report.added.push(path)
      continue
    }
    const known = registry.assets[at]
    if (known[1] === record[1] && known[2] === record[2]) {
      report.unchanged.push(path)
      continue
    }
    registry.assets[at] = record
    report.updated.push(path)
  }
  if (report.added.length || report.updated.length) {
    writeFileSync(registryFile, serializeRegistry(registry), 'utf8')
  }
  return report
}

/**
 * Все файлы каталога внутри `public/assets`, путями от корня реестра.
 *
 * @param {string} prefix
 * @returns {string[]}
 */
export function assetsUnder(prefix) {
  const walk = (/** @type {string} */ directory, /** @type {string} */ relative) => (
    readdirSync(join(ROOT, 'public/assets', directory), { withFileTypes: true }).sort((left, right) => (
      left.name < right.name ? -1 : 1
    )).flatMap((entry) => (entry.isDirectory()
      ? walk(`${directory}/${entry.name}`, `${relative}/${entry.name}`)
      : [`${relative}/${entry.name}`]))
  )
  return walk(prefix, prefix)
}

if (process.argv[1] && process.argv[1].endsWith('register-asset-rights.mjs')) {
  const argv = process.argv.slice(2)
  const underAt = argv.indexOf('--all-under')
  const paths = underAt >= 0 && underAt + 1 < argv.length
    ? assetsUnder(argv[underAt + 1])
    : argv.filter((value) => !value.startsWith('--'))
  if (!paths.length) {
    process.stderr.write('Укажите пути относительно public/assets\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, ...registerAssets(paths) }, null, 2)}\n`)
  }
}
