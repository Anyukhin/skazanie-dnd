import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * Сборка клиентского TypeScript (`src/*.ts`, `src/*.tsx`) для `node:test`.
 *
 * Клиент не исполняется в Node как есть: его надо транспилировать. Раньше каждый
 * тест повторял один и тот же блок — `tsc --ignoreConfig` во временный каталог,
 * переименование `.js` → `.mjs` и дописывание расширений в спецификаторах. Здесь
 * этот блок собран один раз.
 *
 * Что делает сборка:
 * - компилирует точки входа одним вызовом `tsc` с настройками, совпадающими с
 *   `tsconfig.app.json` по строгости (`--strict`, `Bundler`, `ES2022`, DOM);
 * - сохраняет раскладку репозитория (`--rootDir` — корень), поэтому модуль
 *   `src/x.ts` оказывается в `<out>/src/x.mjs`;
 * - переписывает относительные спецификаторы: собранный модуль получает
 *   `.mjs`, а несобранный (`../server/*.mjs`, `./room-stream.mjs` — у них свои
 *   `.d.mts`, и tsc их не выпускает) — абсолютный `file:`-адрес настоящего файла
 *   в репозитории;
 * - кладёт результат в `<корень>/tmp/`, а не в системный временный каталог:
 *   голые спецификаторы (`three`, `react`) разрешаются через `node_modules`
 *   только из дерева репозитория. Каталог `tmp/` в `.gitignore`.
 *
 * Сборка кэшируется в пределах процесса по набору входов и опций: `node --test`
 * запускает каждый файл в своём процессе, и повторный вызов в том же файле
 * получает уже собранные модули — те же экземпляры, что и в первый раз.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const cache = new Map()
const cleanups = new Set()
let exitHookInstalled = false

/** Корень репозитория — для тестов, которым нужны файлы рядом со сборкой. */
export const repositoryRoot = root

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
  })
}

function absoluteEntry(entry) {
  const path = resolve(root, entry)
  assert.ok(existsSync(path), `Нет исходника клиента: ${entry}`)
  return path
}

/** Все `.js` под каталогом сборки, рекурсивно. */
function emittedFiles(dir) {
  const result = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) result.push(...emittedFiles(path))
    else if (name.endsWith('.js')) result.push(path)
  }
  return result
}

/**
 * Переписывает относительные спецификаторы одного выпущенного файла.
 * `emitted` — множество путей выпущенных `.js`, `outDir` — корень сборки.
 */
function rewriteSpecifiers(code, file, emitted, outDir) {
  const sourceDir = resolve(root, relative(outDir, dirname(file)))
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+)\2/gu, (match, before, quote, specifier) => {
    const target = resolve(dirname(file), specifier)
    if (emitted.has(`${target}.js`)) return `${before}${quote}${specifier}.mjs${quote}`
    if (emitted.has(target) && target.endsWith('.js')) return `${before}${quote}${specifier.replace(/\.js$/u, '.mjs')}${quote}`
    // Несобранный модуль: ссылаемся на настоящий файл в репозитории.
    const original = resolve(sourceDir, specifier)
    if (existsSync(original) && statSync(original).isFile()) return `${before}${quote}${pathToFileURL(original).href}${quote}`
    return match
  })
}

/**
 * Собирает клиентские модули и импортирует точки входа.
 *
 * @param {string[]} entries пути исходников относительно корня репозитория
 *   (`'src/board-render.ts'`); зависимости по импортам собираются сами.
 * @param {{ args?: string[], prefix?: string }} [options] `args` — добавочные
 *   флаги tsc; `prefix` — имя каталога сборки внутри `tmp/`.
 * @returns {Promise<{ outDir: string, modules: any[], load: (source: string) => Promise<any>, pathOf: (source: string) => string }>}
 *   `modules` — пространства имён точек входа в том же порядке; `load` —
 *   импорт любого собранного модуля (в том числе зависимости) по пути исходника.
 */
export async function compileClientModules(entries, options = {}) {
  const sources = entries.map(absoluteEntry)
  const args = options.args ?? []
  const key = JSON.stringify([sources, args])
  if (!cache.has(key)) cache.set(key, buildClientModules(sources, args, options.prefix))
  return cache.get(key)
}

async function buildClientModules(sources, args, prefix = 'client-ts-') {
  const tmpRoot = join(root, 'tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const outDir = mkdtempSync(join(tmpRoot, prefix))
  installExitHook()
  cleanups.add(outDir)
  const compiled = spawnSync(process.execPath, [
    compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
    '--lib', 'ES2022,DOM,DOM.Iterable', '--jsx', 'react-jsx', '--strict', '--skipLibCheck', '--esModuleInterop',
    ...args, '--rootDir', root, '--outDir', outDir, ...sources,
  ], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)

  const files = emittedFiles(outDir)
  const emitted = new Set(files)
  for (const file of files) {
    writeFileSync(file, rewriteSpecifiers(readFileSync(file, 'utf8'), file, emitted, outDir))
  }
  for (const file of files) renameSync(file, file.replace(/\.js$/u, '.mjs'))

  const pathOf = (source) => {
    const relativePath = relative(root, absoluteEntry(source)).split(sep).join('/')
    return join(outDir, relativePath.replace(/\.tsx?$/u, '.mjs'))
  }
  const load = (source) => import(pathToFileURL(pathOf(source)).href)
  const modules = []
  for (const source of sources) modules.push(await load(source))
  return { outDir, modules, load, pathOf }
}
