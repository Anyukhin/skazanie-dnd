import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WANTED_LEVEL_LABELS, guardOptionsFor, guardEncounterTriggerFor } from '../server/law-and-order.mjs'
import { merchantViewFor } from '../server/merchant-economy.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const shop = readFileSync(new URL('../src/MerchantView.tsx', import.meta.url), 'utf8')
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
  assert.equal(north.cleared, null, 'край отряд ещё не прощал')
})

/**
 * Реестр снятий раньше копился в состоянии, не отвечая ни на один вопрос за
 * столом. Теперь он едет лентой и виден строкой в карточке ведущего.
 */
test('снятие розыска остаётся в ленте и подписано в карточке ведущего', () => {
  const guilty = applyGameEvent(campaign(), murder)
  const forgiven = applyGameEvent(guilty, {
    event_id: 'evt-amnesty', command_id: 'cmd-amnesty', event_type: 'WantedCleared', actor_id: null,
    target_ids: [], visibility: 'gm_only',
    payload: {
      region_id: 'north', region_name: 'Северный край', reason: 'amnesty',
      crime_ids: guilty.law.crimes.map((crime) => crime.id), at_minutes: 120,
    },
  })
  const admin = campaignStateForViewer(forgiven, { id: 'user-gm', role: 'admin', heroIds: [] }, '')
  const north = admin.law.regions.find((region) => region.region_id === 'north')

  assert.equal(north.level, 0, 'амнистия снимает ступень')
  assert.equal(north.cleared.reason, 'amnesty')
  assert.equal(north.cleared.at_minutes, 120)
  assert.match(views, /WANTED_CLEAR_LABELS/u)
  assert.match(views, /wanted-cleared/u)
  assert.match(styles, /\.wanted-region > small\.wanted-cleared \{/u)
})

/**
 * Витрина обязана называть настоящую причину отказа. Сервер шлёт её отдельным
 * полем (`can_buy` + `unavailable_reason`), а витрина до ревью 2026-08-09 читала
 * только `max_quantity` — и герой с полным кошелём получал «Недостаточно монет»
 * вместо «Торговец не станет иметь дела с теми, кого ищет стража».
 */
test('лавка под розыском отказывает причиной, и витрина эту причину читает', () => {
  const base = campaign()
  const stocked = normalizeCampaignState({
    ...base,
    players: [{
      ...base.players[0],
      inventory: [{ id: 'item-rope', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', name: 'Верёвка пеньковая (50 футов)', quantity: 1, type: 'gear' }],
    }],
    merchants: [{
      id: 'merchant-1', name: 'Лавочник', location: VILLAGE, available: true, purse_cp: 20_000,
      stock: [{ stock_id: 'stock-1', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', quantity: 4 }],
      services: [],
    }],
    social: { ...base.social, npcs: [...base.social.npcs, { id: 'merchant-1', name: 'Лавочник', location: VILLAGE, visibility: 'party', tags: ['faction:brod-folk'] }] },
  })
  const arson = {
    event_id: 'evt-arson', command_id: 'cmd-arson', event_type: 'SceneObjectOperated', actor_id: 'hero',
    target_ids: [], payload: { prop_id: 'hay-1', kind: 'furnishing', intent: 'ignite' }, visibility: 'party',
  }
  const hunted = applyGameEvent(applyGameEvent(stocked, murder), arson)
  const view = merchantViewFor(hunted, 'merchant-1', 'hero')

  const buy = view.buy_quotes[0]
  assert.equal(buy.can_buy, false, 'сервер закрывает покупку отдельным полем, а не нулём в количестве')
  assert.ok(buy.unavailable_reason, 'и объявляет причину')
  assert.equal(buy.max_quantity, 0)
  assert.ok(buy.can_afford, 'денег у героя хватает — отказ не про них')

  const sell = view.sell_quotes[0]
  assert.equal(sell.can_sell, false)
  assert.ok(sell.unavailable_reason, 'на вкладке продажи причина приходит тем же полем')

  // Клиент читает именно эти поля: `reason` про предмет, `unavailable_reason` —
  // про отряд, и денежная ветка их больше не подменяет.
  assert.match(shop, /quote\?\.can_buy === false/u)
  assert.match(shop, /quote\.unavailable_reason \|\| 'Торговец отказывает отряду'/u)
  assert.match(shop, /const sellRefusal = quote\?\.unavailable_reason \|\| quote\?\.reason/u)
  assert.match(shop, /tradeRefusal \? 'Отказано'/u)
})

test('встреча со стражей живёт на доске отдельной панелью с четырьмя ответами', () => {
  assert.match(board, /className="guard-panel"/u)
  assert.match(board, /aria-label="Встреча со стражей"/u)
  assert.match(board, /state\.law\?\.encounter/u)
  assert.match(board, /onResolveGuardEncounter\(option\.id/u)
  // Пока офицер стоит перед отрядом, уход из локации закрыт: сервер такой
  // переход не пропустит, и кнопка обязана говорить об этом, а не падать
  // ошибкой после нажатия.
  assert.match(board, /disabled=\{narrating \|\| tacticalBusy \|\| Boolean\(guardEncounter\)\}/u)
  assert.match(board, /Стража стоит перед отрядом — сначала ответьте офицеру/u)
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
