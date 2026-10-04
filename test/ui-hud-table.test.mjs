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
