import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

/**
 * Строка боевой хроники — единственное, чем механика говорит со столом словами.
 * Тестов у неё не было ни одного: `battleEventText` живёт в `src/app-shared.tsx`
 * рядом с JSX, а корпус запускает интерфейс только через `tsc` во временный
 * каталог, и эмитированный `react/jsx-runtime` оттуда не разрешается.
 *
 * Поэтому среда интерфейса подменяется заглушкой: модуль компилируется как
 * есть, а все его внешние импорты — среда JSX, хуки React и набор значков —
 * переписываются на одну пустышку рядом. Компоненты и хуки тест не вызывает,
 * проверяется чистая функция; подмена нужна лишь для того, чтобы модуль вообще
 * загрузился. Так под сторожем оказывается настоящий исходник, а не его копия.
 *
 * Держит он два обещания шага «враги пускают в ход снаряжение»: лечение без
 * величины называется словами, а не «+0», и лечение самого себя не превращается
 * в двух участников на доске.
 */
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-battle-text-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sharedPath = fileURLToPath(new URL('../src/app-shared.tsx', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--jsx', 'react-jsx', '--outDir', buildDir, sharedPath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
writeFileSync(
  join(buildDir, 'ui-runtime.mjs'),
  [
    'export const Fragment = Symbol("fragment")',
    'export const jsx = () => null',
    'export const jsxs = () => null',
    'export const useEffect = () => {}',
    'export const useRef = (value) => ({ current: value })',
    'export const useState = (value) => [value, () => {}]',
    'export const CircleAlert = () => null',
    'export const X = () => null',
    '',
  ].join('\n'),
)
const modulePath = join(buildDir, 'app-shared.mjs')
writeFileSync(modulePath, readFileSync(join(buildDir, 'app-shared.js'), 'utf8')
  .replace(/from (["'])(?:react\/jsx-runtime|react|lucide-react)\1/gu, 'from "./ui-runtime.mjs"'))
const { battleEventText } = await import(pathToFileURL(modulePath).href)

test.after(() => rmSync(buildDir, { recursive: true, force: true }))

/** Отряд из одного героя и опознанный союзник-противник рядом. */
function state({ healthKnown = 'banded' } = {}) {
  return {
    players: [{ id: 'hero', character: 'Ада' }],
    enemies: [{ id: 'foe', name: 'Берсерк', healthKnown }],
    actors: [],
  }
}

test('лечение без величины называется словами, а не нулём', () => {
  // Ровно тот случай, ради которого сервер снимает число: зелье противника.
  // Величины в записи нет, и «+0 ОЗ» означало бы, что склянка не сработала.
  const text = battleEventText(state(), { id: 'b1', type: 'healing', actorId: 'foe', targetId: 'foe' })
  assert.equal(text, 'Берсерк лечит себя: раны затягиваются.')
  assert.equal(text.includes('+0'), false)
  assert.equal(/\d/u.test(text), false, 'в записи без величины не должно быть чисел вовсе')

  // Опознанному существу число приходит и печатается вместе с полосой ОЗ.
  assert.equal(
    battleEventText(state({ healthKnown: 'exact' }), {
      id: 'b2', type: 'healing', actorId: 'foe', targetId: 'foe', healing: 10, hpBefore: 8, hpAfter: 18,
    }),
    'Берсерк лечит себя: +10 ОЗ · 8 → 18.',
  )
})

test('лечение себя и лечение другого — две разные строки', () => {
  assert.equal(
    battleEventText(state(), {
      id: 'b3', type: 'healing', actorId: 'hero', targetId: 'hero', healing: 7, hpBefore: 3, hpAfter: 10,
      spellId: 'cure-wounds', spellName: 'Лечение ран',
    }),
    'Ада лечит себя заклинанием «Лечение ран»: +7 ОЗ · 3 → 10.',
  )
  // Тот же герой, но цель другая: имя цели обязано вернуться в строку.
  const other = battleEventText({
    ...state(),
    players: [{ id: 'hero', character: 'Ада' }, { id: 'ally', character: 'Бор' }],
  }, { id: 'b4', type: 'healing', actorId: 'hero', targetId: 'ally', healing: 7, hpBefore: 3, hpAfter: 10 })
  assert.equal(other, 'Ада лечит Бор: +7 ОЗ · 3 → 10.')
  assert.equal(other.includes('себя'), false)
})

test('поступок противника со снаряжением называет подпись сервера, а не вещь', () => {
  assert.equal(
    battleEventText(state(), { id: 'b5', type: 'npc-item', actorId: 'foe', label: 'прикладывается к склянке' }),
    'Берсерк прикладывается к склянке.',
  )
  // Подписи нет — строка всё равно остаётся человеческой и вещь не называет.
  assert.equal(
    battleEventText(state(), { id: 'b6', type: 'npc-item', actorId: 'foe' }),
    'Берсерк пускает в ход своё снаряжение.',
  )
})
