#!/usr/bin/env node
// Собирает список действий, у которых есть собственный рисунок.
//
// Файлы лежат в public/ и потому невидимы для сборщика: Vite отдаёт их как есть
// и не может обойти их через import.meta.glob. Поэтому список нужен явный —
// иначе интерфейсу пришлось бы пробовать загрузить картинку и ловить 404 на
// каждое действие без рисунка, а их пока пять сотен.
//
// Запуск: pnpm icons:manifest
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const ICON_DIR = new URL('../public/assets/ui/action-icons/', import.meta.url)
const MANIFEST = new URL('../src/action-icons.ts', import.meta.url)

export function iconIdsOnDisk() {
  return readdirSync(ICON_DIR)
    .filter((name) => name.endsWith('.png'))
    .map((name) => name.slice(0, -'.png'.length))
    .sort()
}

export function manifestSource(ids) {
  return `// Собран автоматически: pnpm icons:manifest. Руками не править.
// Идентификаторы действий и заклинаний, у которых есть собственный рисунок
// public/assets/ui/action-icons/<id>.png. Всё остальное берёт клетку атласа.
export const ACTION_ICON_IDS: ReadonlySet<string> = new Set([
${ids.map((id) => `  '${id}',`).join('\n')}
])
`
}

export function manifestIsCurrent() {
  const expected = manifestSource(iconIdsOnDisk())
  let actual = ''
  try { actual = readFileSync(MANIFEST, 'utf8') } catch { return false }
  return actual.replace(/\r\n/gu, '\n') === expected
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/gu, '/')}` || process.argv[1]?.endsWith('build-icon-manifest.mjs')) {
  const ids = iconIdsOnDisk()
  writeFileSync(MANIFEST, manifestSource(ids), 'utf8')
  console.log(JSON.stringify({ ok: true, icons: ids.length, manifest: 'src/action-icons.ts' }, null, 2))
}
