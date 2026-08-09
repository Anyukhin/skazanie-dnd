import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WANTED_LEVEL_LABELS, guardOptionsFor, guardEncounterTriggerFor } from '../server/law-and-order.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const VILLAGE = 'Тихий Брод'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'LAW-UI',
    campaign: 'Закон у ворот',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: { title: 'Площадь', location: VILLAGE, location_id: 'village', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [], currency: { copper: 0, silver: 0, gold: 50, platinum: 0 } }],
    worldMap: {
      seed: 'law-ui-seed',
      regions: [
        { id: 'north', name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 },
        { id: 'south', name: 'Южный край', biome: 'marsh', x: 200, y: 520, radius: 205 },
        { id: 'east', name: 'Восточный край', biome: 'coast', x: 820, y: 300, radius: 205 },
      ],
      locations: [
        { id: 'village', name: VILLAGE, kind: 'village', x: 200, y: 200, regionId: 'north' },
        { id: 'road', name: 'Старый тракт', kind: 'landmark', x: 260, y: 240, regionId: 'north' },
      ],
      routes: [{ id: 'r1', from: 'village', to: 'road', kind: 'road' }],
    },
    social: { npcs: [
      { id: 'baker', name: 'Пекарь Мила', role: 'пекарь', location: VILLAGE, visibility: 'party', public_summary: 'Пекарь.' },
      { id: 'smith', name: 'Кузнец Гор', role: 'кузнец', location: VILLAGE, visibility: 'party', public_summary: 'Кузнец.' },
    ] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
}

const murder = {
  event_id: 'evt-murder', command_id: 'cmd-murder', event_type: 'NpcDied', actor_id: 'hero',
  target_ids: ['victim'], payload: { npc_id: 'victim', npc_name: 'Возчик Сём', source_actor_id: 'hero' },
  visibility: 'party',
}

/** Кампания, где закон уже поднял ступень и стража стоит перед отрядом. */
function stopped() {
  const guilty = applyGameEvent(campaign(), murder)
  const encounter = guardEncounterTriggerFor(guilty, { commandId: 'cmd-enter' })
  return applyGameEvent(guilty, {
    event_id: 'evt-guard', command_id: 'cmd-enter', event_type: 'GuardEncounterStarted',
    actor_id: 'hero', target_ids: [], payload: { encounter }, visibility: 'party',
  })
}

test('карточка встречи доезжает игроку готовой: офицер, требование и четыре ответа', () => {
  const state = stopped()
  const player = campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  const card = player.law.encounter

  assert.ok(card, 'стража видна игроку')
  assert.ok(card.officer_name, 'у офицера есть имя')
  assert.ok(card.officer_rank, 'и чин')
  assert.match(card.demand, /«/u, 'требование офицера — реплика, а не служебная строка')
  assert.deepEqual(card.options.map((option) => option.id), ['fine', 'surrender', 'flee', 'fight'])
  for (const option of card.options) {
    assert.ok(option.label, `у исхода ${option.id} есть подпись`)
    assert.ok(option.summary, `у исхода ${option.id} есть пояснение`)
  }
  // Подписи серверные: клиент их не сочиняет и не додумывает.
  assert.deepEqual(guardOptionsFor(state.law.encounter).map((option) => option.label), card.options.map((option) => option.label))
})

test('цифры розыска в проекции игрока нет ни в одном поле', () => {
  const state = stopped()
  const player = campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  const serialized = JSON.stringify(player.law)

  assert.equal(player.law.encounter.level, undefined)
  assert.ok(!serialized.includes('"level"'))
  assert.ok(!serialized.includes('"points"'))
  assert.ok(!serialized.includes('"regions"'))
  // Вместо цифры — мир: приметы приходят строками и растут со ступенью.
  assert.ok(Array.isArray(player.law.signs) && player.law.signs.length > 0)
  for (const sign of player.law.signs) assert.match(sign, /^[А-ЯЁ]/u, 'примета написана по-русски и человеческой фразой')
})

test('ведущий получает ленту по краям со ступенью, очками и сроком затухания', () => {
  const admin = campaignStateForViewer(stopped(), { id: 'user-gm', role: 'admin', heroIds: [] }, '')
  const north = admin.law.regions.find((region) => region.region_id === 'north')

  assert.equal(north.level, 2)
  assert.equal(north.points, 4)
  assert.equal(north.label, WANTED_LEVEL_LABELS[2])
  assert.equal(north.here, true)
  assert.ok(north.next_decay_in_minutes > 0, 'ведущий видит, когда сгорит очко')
  assert.equal(north.crimes.length, 1)
  assert.ok(north.crimes[0].summary)
})

test('встреча со стражей живёт на доске отдельной панелью с четырьмя ответами', () => {
  assert.match(board, /className="guard-panel"/u)
  assert.match(board, /aria-label="Встреча со стражей"/u)
  assert.match(board, /state\.law\?\.encounter/u)
  assert.match(board, /onResolveGuardEncounter\(option\.id/u)
  // Подходы к побегу выбирает игрок, навык уезжает командой.
  assert.match(board, /guard-escape-skill/u)
  assert.match(board, /Скрытность/u)
  assert.match(board, /Атлетика/u)
  // Своей таблицы исходов и своей ступени у доски быть не должно.
  assert.doesNotMatch(board, /GUARD_OPTION_LABELS/u)
  assert.doesNotMatch(board, /law\?\.encounter\?\.level/u)
})

test('приметы розыска стоят в шапке сцены, а не индикатором со ступенью', () => {
  assert.match(app, /className="scene-wanted"/u)
  assert.match(app, /wantedSigns=\{state\.law\?\.signs \?\? \[\]\}/u)
  assert.doesNotMatch(app, /wantedLevel/u)
})

test('карточка закона живёт в админке, подписана по-русски и даёт амнистию', () => {
  assert.match(views, /<WantedCard state=\{state\} \/>/u)
  assert.match(views, /admin-card admin-wanted/u)
  assert.match(views, /Закон и розыск/u)
  assert.match(views, /Амнистия/u)
  assert.match(views, /ClearWantedLevel/u)
  // Пороги ступеней и порядок краёв считает сервер: своей таблицы здесь нет.
  assert.doesNotMatch(views, /WANTED_LEVEL_THRESHOLDS/u)
  assert.doesNotMatch(views, /law\?\.regions[^\n]*\.sort\(/u)
})

test('панели закона оформлены и не ломают узкий экран', () => {
  assert.match(styles, /\.guard-panel \{/u)
  assert.match(styles, /\.guard-option \{/u)
  assert.match(styles, /\.guard-option\.option-fight \{/u)
  assert.match(styles, /\.scene-wanted \{/u)
  assert.match(styles, /\.wanted-region \{/u)
  assert.match(styles, /\.wanted-region\.tier-wanted \{/u)
  assert.match(styles, /\.wanted-region li \{ grid-template-columns: 1fr; \}/u)
})
