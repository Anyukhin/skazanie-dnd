import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('каждая палитра из настроек объявлена в CSS и задаёт основу цветов', async () => {
  const [palettes, css] = await Promise.all([read('../src/ui-palette.ts'), read('../src/hud-palette.css')])
  const ids = [...palettes.matchAll(/\{ id: '([a-z]+)', name: '/g)].map((match) => match[1])
  assert.deepEqual(ids, ['tavern', 'espresso', 'moss', 'graphite', 'ink', 'wine', 'ash', 'parchment'])
  for (const id of ids.filter((value) => value !== 'tavern')) {
    const block = css.match(new RegExp(`:root\\[data-pal="${id}"\\] \\{([^}]*)\\}`))
    assert.ok(block, `палитра ${id} объявлена`)
    for (const token of ['--bg', '--panel', '--raise', '--text', '--text2', '--muted', '--acc', '--acc2', '--frame', '--hp', '--ally', '--enemy']) {
      assert.match(block[1], new RegExp(`${token}:`), `палитра ${id} задаёт ${token}`)
    }
  }
  // «Таверна» — прежние цвета сайта: без выбора интерфейс не меняется.
  assert.match(css, /:root\[data-pal="tavern"\] \{[^}]*--spent: #4d463e;/)
})

test('выбор палитры, ширины колонок и мини-карты не падает без localStorage', async () => {
  const [palettes, parts] = await Promise.all([read('../src/ui-palette.ts'), read('../src/hud-parts.tsx')])
  for (const source of [palettes, parts]) {
    const calls = source.match(/localStorage\.(getItem|setItem|removeItem)/g) ?? []
    const guarded = [...source.matchAll(/try \{([\s\S]*?)\} catch/g)]
      .flatMap((block) => block[1].match(/localStorage\.(getItem|setItem|removeItem)/g) ?? [])
    assert.ok(calls.length > 0)
    assert.equal(guarded.length, calls.length, 'каждое обращение к localStorage обёрнуто в try')
  }
})

test('элементы HUD читают серверную проекцию и вызывают существующие команды', async () => {
  const [map, app] = await Promise.all([read('../src/DungeonMap.tsx'), read('../src/App.tsx')])
  // Спасброски — из mechanics.death.saving_throws, кнопки броска нет: его делает сервер.
  assert.match(map, /state\.mechanics\?\.death\?\.saving_throws\?\.\[ownHero\.id\]/)
  // Круг ячейки у плитки ложится в тот же slot_level, что и список «Ячейка».
  assert.match(map, /onPick=\{\(level\) => \{\s*setSpellSlotLevelChoice\(level\)/)
  // «Не убивать» — тот же флаг knock_out атаки ближнего боя.
  assert.match(map, /knockout-turn-toggle[^\n]*aria-pressed=\{knockOut\}/)
  // Окно реакции: те же команды выбора и отказа, часы — серверный turn_clock.
  assert.match(app, /onDecline=\{\(\) => useCombatAction\(reactionWindow\.actor_id, 'decline-reaction'\)\}/)
  assert.match(app, /clock\.reaction_window_id === window\.id/)
  // Вдохновения и наборов оружия на сервере нет — и в интерфейсе их нет.
  assert.doesNotMatch(app + map, /Вдохновение: (есть|нет)/)
  assert.doesNotMatch(app + map, /Набор оружия/)
})

test('высота нижней панели меняется целыми рядами плиток, а не пикселями', async () => {
  const [parts, map, css] = await Promise.all([read('../src/dungeon-map-parts.tsx'), read('../src/DungeonMap.tsx'), read('../src/bg3-hud.css')])
  // Предел рядов зависит от окна: панель не выше 40 % высоты, от двух до пяти рядов.
  const limitSource = /export function hudRowsLimit\(viewportHeight: number\) \{([\s\S]*?)\n\}/.exec(parts)
  assert.ok(limitSource, 'hudRowsLimit объявлена')
  const constants = Object.fromEntries([...parts.matchAll(/export const (HUD_ROWS_(?:MIN|MAX|DEFAULT)) = (\d+)/g)].map((match) => [match[1], Number(match[2])]))
  assert.deepEqual(constants, { HUD_ROWS_MIN: 2, HUD_ROWS_MAX: 5, HUD_ROWS_DEFAULT: 3 })
  const hudRowsLimit = new Function('HUD_ROWS_MIN', 'HUD_ROWS_MAX', 'viewportHeight', limitSource[1])
    .bind(null, constants.HUD_ROWS_MIN, constants.HUD_ROWS_MAX)
  assert.equal(hudRowsLimit(1080), 5)
  assert.equal(hudRowsLimit(900), 4)
  assert.equal(hudRowsLimit(768), 3)
  assert.equal(hudRowsLimit(500), 2)
  // Ручка, «+ / −» и стрелки меняют одно число рядов; пиксельной высоты больше нет.
  assert.match(map, /className="rail-resize"[^\n]*aria-valuenow=\{hudRows\}[^\n]*onKeyDown=\{resizeRailWithKeys\}/)
  assert.match(map, /aria-label="Добавить ряд"/)
  assert.match(map, /aria-label="Убрать ряд"/)
  assert.doesNotMatch(map, /setProperty\('--ui-rail-height'/)
  assert.match(map, /<section className="turn-rail" ref=\{turnRailRef\} data-rows=\{hudRows\}/)
  // Панель — по содержимому: плитки задают высоту рядами, колонки сбоку — во всю высоту.
  const panel = /\.game-area \.turn-rail \{\n    --hud-line:[\s\S]*?\n  \}/.exec(css.replace(/\r\n/g, '\n'))
  assert.ok(panel, 'блок раскладки панели найден')
  assert.match(panel[0], /height: auto; min-height: 0; max-height: none; overflow: visible;/)
  assert.match(panel[0], /grid-template-areas: 'hero \. side' 'hero tray side' 'hero main side' 'hero decks side' 'hero \. side';/)
  assert.match(css, /grid-template-rows: repeat\(var\(--hud-rows, 3\), var\(--hud-cell\)\);/)
})
