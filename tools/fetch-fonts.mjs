#!/usr/bin/env node
// @ts-check
/**
 * Забирает гарнитуры интерфейса с Google Fonts в `public/assets/fonts` и
 * печатает `src/fonts.css` с `@font-face` на локальные файлы.
 *
 * Зачем файлы в репозитории, а не `@import` с Google: сервер отдаёт CSP
 * `style-src 'self'`, и в проде подключение к fonts.googleapis.com
 * блокируется — игроки видели системные Segoe UI и Times вместо задуманных
 * гарнитур, а dev-сборка без CSP показывала задуманное. Со своими файлами сеть
 * и CSP не участвуют, и дев с продом совпадают.
 *
 * Берутся только подмножества latin и cyrillic: интерфейс русский, латиница —
 * для кодов комнат и цифр. Лицензия всех гарнитур — SIL OFL 1.1, бандлить
 * можно; происхождение и версии — в `docs/fonts.md`. После запуска файлы
 * регистрируются в реестре прав: `node tools/register-asset-rights.mjs --all-under fonts`.
 *
 * Запуск: node tools/fetch-fonts.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const FONTS_DIR = join(ROOT, 'public/assets/fonts')
const CSS_OUT = join(ROOT, 'src/fonts.css')
// Четыре роли (docs/fonts.md): Alegreya Sans — интерфейс, Alegreya Sans SC —
// подписи капителью, Alegreya — рассказ (с курсивом: в нём звучат реплики),
// Cormorant SC — заголовки.
const API = 'https://fonts.googleapis.com/css2'
  + '?family=Alegreya:ital,wght@0,400;0,500;0,700;1,400'
  + '&family=Alegreya+Sans:wght@400;500;700;800'
  + '&family=Alegreya+Sans+SC:wght@500;700'
  + '&family=Cormorant+SC:wght@500;600;700'
  + '&display=swap'
// Без UA браузера с поддержкой woff2 API отдаёт ttf целиком, без подмножеств.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const SUBSETS = new Set(['latin', 'cyrillic'])

const css = await (await fetch(API, { headers: { 'User-Agent': USER_AGENT } })).text()

/** @type {Array<{ family: string, style: string, weights: number[], subset: string, range: string, url: string }>} */
const faces = []
for (const [, subset, body] of css.matchAll(/\/\* (\w[\w-]*) \*\/\s*@font-face \{([\s\S]*?)\}/gu)) {
  if (!SUBSETS.has(subset)) continue
  const family = body.match(/font-family: '([^']+)'/u)?.[1]
  const style = body.match(/font-style: (\w+)/u)?.[1] ?? 'normal'
  const weight = Number(body.match(/font-weight: (\d+)/u)?.[1])
  const url = body.match(/url\((https:[^)]+\.woff2)\)/u)?.[1]
  const range = body.match(/unicode-range: ([^;]+);/u)?.[1]
  if (!family || !weight || !url || !range) throw new Error(`неполный блок: ${subset} ${family} ${weight}`)
  // Вариативный шрифт (Alegreya) отдаёт один файл на все веса: такой файл
  // качается один раз, а объявление получает диапазон весов.
  const twin = faces.find((face) => face.url === url)
  if (twin) twin.weights.push(weight)
  else faces.push({ family, style, weights: [weight], subset, range, url })
}

mkdirSync(FONTS_DIR, { recursive: true })
const declarations = []
for (const face of faces) {
  const variable = face.weights.length > 1
  const slug = face.family.toLowerCase().replaceAll(' ', '-')
  const file = `${slug}-${face.subset}-${variable ? 'variable' : String(face.weights[0])}${face.style === 'italic' ? '-italic' : ''}.woff2`
  const bytes = new Uint8Array(await (await fetch(face.url)).arrayBuffer())
  writeFileSync(join(FONTS_DIR, file), bytes)
  process.stdout.write(`${file} ${bytes.length} B ← ${face.url}\n`)
  declarations.push([
    '@font-face {',
    `  font-family: '${face.family}';`,
    `  font-style: ${face.style};`,
    `  font-weight: ${variable ? `${Math.min(...face.weights)} ${Math.max(...face.weights)}` : face.weights[0]};`,
    '  font-display: swap;',
    `  src: url('/assets/fonts/${file}') format('woff2');`,
    `  unicode-range: ${face.range};`,
    '}',
  ].join('\n'))
}
writeFileSync(CSS_OUT, [
  '/* Гарнитуры интерфейса — локальные файлы, см. tools/fetch-fonts.mjs и docs/fonts.md.',
  '   Файл сгенерирован инструментом; руками не править. */',
  ...declarations,
  '',
].join('\n'))
process.stdout.write(`\n${declarations.length} начертаний → ${CSS_OUT}\n`)
