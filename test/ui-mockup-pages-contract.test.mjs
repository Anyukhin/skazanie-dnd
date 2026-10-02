import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { createCampaignWorldMap } from '../server/world-map.mjs'

/**
 * Сторож страниц по макету «Сказание — редизайн интерфейса»: «Отряд»
 * (`src/PartyPage.tsx`), «Карта мира» (`src/WorldMapView.tsx`) и раскладка
 * телефона (`src/MobileTabBar.tsx`, `src/mockup-pages.css`).
 *
 * DOM-раннера в проекте нет, поэтому проверка идёт с двух сторон, как в
 * `ui-player-screens-contract.test.mjs`: (1) проекция игрока действительно
 * несёт поля, которые читают страницы, и не несёт чужого; (2) разметка
 * исходников держит договор — одна страница отряда, никаких собственных
 * запросов к серверу из страниц, мобильное — только под медиазапросом.
 */

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function campaign() {
  const worldMap = createCampaignWorldMap({ seed: 'mockup-pages', campaignName: 'Причал', startingLocation: 'Норвин' })
  return normalizeCampaignState({
    sessionCode: 'UI-PAGES',
    partyMemberIds: ['hero', 'ally'],
    activePlayerId: 'hero',
    scene: { title: 'Причал в тумане', location: 'Норвин', cells: [] },
    players: [
      { id: 'hero', character: 'Тордин', role: 'Варвар · ур. 1', characterClass: 'barbarian', level: 1, hp: 15, maxHp: 15, armor: 14, speed: 25, proficiency: 2,
        abilities: { str: 17, dex: 12, con: 16, int: 8, wis: 12, cha: 10 }, currency: { gold: 10, silver: 4 }, inventory: [] },
      { id: 'ally', character: 'Мирра', role: 'Жрица · ур. 1', characterClass: 'cleric', level: 1, hp: 9, maxHp: 9, armor: 18, speed: 30, proficiency: 2,
        abilities: { str: 14, dex: 10, con: 13, int: 10, wis: 16, cha: 12 }, currency: { gold: 3 }, inventory: [] },
    ],
    worldMap,
    worldMemory: {
      entities: [], facts: [], relationships: [], epistemic_claims: [], knowledge_ledger: [], threads: [], summaries: [],
      quests: [{ id: 'quest:pier', title: 'Пропавший сын', status: 'active', visibility: 'party', entity_ids: [], objectives: [], clock: { current: 0, max: 4, label: 'Улики' } }],
    },
  })
}

const asPlayer = (state) => campaignStateForViewer(state, { role: 'player', id: 'u1' }, 'hero')

test('отряд: проекция несёт всё, что рисует карточка героя', () => {
  const projected = asPlayer(campaign())
  for (const hero of projected.players) {
    for (const key of ['str', 'dex', 'con', 'int', 'wis', 'cha']) assert.equal(typeof hero.abilities?.[key], 'number', `${hero.id}: характеристика ${key}`)
    for (const key of ['hp', 'maxHp', 'armor', 'speed', 'proficiency']) assert.equal(typeof hero[key], 'number', `${hero.id}: ${key}`)
    assert.equal(typeof hero.currency, 'object', `${hero.id}: кошелёк героя`)
  }
  const resources = projected.mechanics?.resources ?? {}
  assert.ok(resources.hero && Object.keys(resources.hero).length > 0, 'запасы своего героя доезжают до игрока')
})

test('отряд: кости хитов приходят только своему герою — у соратника строки нет', () => {
  const projected = asPlayer(campaign())
  const dice = projected.mechanics?.hit_point_dice ?? {}
  assert.deepEqual(Object.keys(dice), ['hero'])
  assert.equal(typeof dice.hero.maximum, 'number')
  assert.equal(typeof dice.hero.die_size, 'number')
})

test('отряд: сводка задач читает worldMemory.quests с часами', () => {
  const quest = asPlayer(campaign()).worldMemory?.quests?.find((entry) => entry.id === 'quest:pier')
  assert.ok(quest)
  assert.equal(quest.status, 'active')
  assert.deepEqual([quest.clock.current, quest.clock.max], [0, 4])
})

test('карта мира: список мест строится из известных точек проекции без внутреннего seed', () => {
  const map = asPlayer(campaign()).worldMap
  assert.ok(map)
  assert.equal(map.seed, undefined)
  const regionIds = new Set(map.regions.map((region) => region.id))
  for (const location of map.locations) {
    assert.equal(typeof location.known, 'boolean')
    assert.equal(typeof location.visited, 'boolean')
    assert.ok(regionIds.has(location.regionId), `${location.id}: регион места известен клиенту`)
  }
})

test('страница отряда одна: прежний CharactersView удалён, раздел рисует PartyPage', () => {
  const app = source('src/App.tsx')
  assert.doesNotMatch(app, /function CharactersView\b/u)
  assert.match(app, /view === 'characters' && <PartyPage\b/u)
  assert.match(app, /<MobileTabBar\b/u)
})

test('страницы не ходят на сервер сами: приглашение и отдых — через команды комнаты', () => {
  for (const path of ['src/PartyPage.tsx', 'src/MobileTabBar.tsx']) {
    const text = source(path)
    assert.doesNotMatch(text, /\bfetch\(|fetchWithTimeout/u, `${path} не обращается к API напрямую`)
  }
  const party = source('src/PartyPage.tsx')
  assert.match(party, /onStartRest\(kind\)/u, 'отдых — та же команда StartRest, что и в комнате')
  assert.match(party, /onClick=\{onInvite\}/u, 'приглашение — то же окно, что в шапке комнаты')
})

test('мобильная раскладка живёт только под медиазапросом ≤ 760px и подключена после раскладки стола', () => {
  const css = source('src/mockup-pages.css')
  const mediaAt = css.search(/^@media \(max-width: 760px\) \{/mu)
  assert.ok(mediaAt > 0, 'есть мобильный медиазапрос')
  assert.match(css.slice(0, mediaAt), /\.mobile-tabbar \{ display: none; \}/u, 'на широком экране панели вкладок нет')
  assert.doesNotMatch(css.slice(0, mediaAt), /\.app-rail\b|\.game-area\b|\.turn-rail\b/u, 'стол на широком экране этот файл не трогает')
  const main = source('src/main.tsx')
  assert.ok(main.indexOf("import './mockup-pages.css'") > main.indexOf("import './prototype-layout.css'"))
})
