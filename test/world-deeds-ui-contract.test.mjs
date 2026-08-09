import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { DEED_KINDS } from '../server/world-deeds.mjs'
import { campaignClockLabel } from '../src/desktop-ui.mjs'

const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const VILLAGE = 'Тихий Брод'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'DEEDS-UI',
    campaign: 'Лента ведущего',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: { title: 'Площадь', location: VILLAGE, location_id: 'village', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    social: { npcs: [
      { id: 'guard', name: 'Страж Бран', role: 'страж', location: VILLAGE, visibility: 'party', public_summary: 'Страж.' },
      { id: 'baker', name: 'Пекарь Мила', role: 'пекарь', location: VILLAGE, visibility: 'party', public_summary: 'Пекарь.' },
    ] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
}

const arson = {
  event_id: 'evt-arson', command_id: 'cmd-arson', event_type: 'SceneObjectOperated', actor_id: 'hero',
  target_ids: [], payload: { prop_id: 'prop-1', kind: 'furnishing', intent: 'ignite' }, visibility: 'public',
}
const clockTick = {
  event_id: 'evt-time', command_id: 'cmd-time', event_type: 'TimeAdvanced', actor_id: 'hero',
  target_ids: [], payload: { amount: 100, unit: 'minute', elapsed_minutes: 100 }, visibility: 'public',
}
const death = {
  event_id: 'evt-death', command_id: 'cmd-death', event_type: 'NpcDied', actor_id: 'hero',
  target_ids: ['guard'], payload: { npc_id: 'guard', npc_name: 'Страж Бран', location_id: 'village', source_actor_id: 'hero' },
  visibility: 'party',
}

test('мировые минуты читаются ведущим как день и время', () => {
  assert.equal(campaignClockLabel(0), 'день 1, 00:00')
  assert.equal(campaignClockLabel(725), 'день 1, 12:05')
  assert.equal(campaignClockLabel(1_440), 'день 2, 00:00')
  assert.equal(campaignClockLabel(-10), 'день 1, 00:00')
})

/**
 * Главный контракт карточки — не текст шаблонной строки, а данные, которые
 * доезжают ведущему. Проверяется он поведением проекции: карточка ничего не
 * досчитывает, поэтому пустая или неотсортированная лента здесь и падает.
 */
test('ведущий получает летопись готовой лентой: подпись, счёт свидетелей, свежее сверху', () => {
  let state = applyGameEvent(campaign(), arson)
  state = applyGameEvent(state, clockTick)
  state = applyGameEvent(state, death)

  const admin = campaignStateForViewer(state, { id: 'user-gm', role: 'admin', heroIds: [] }, '')
  const feed = admin.world_deeds.deeds
  assert.equal(feed.length, 2)
  // Свежее сверху — сортировка серверная, клиент её не повторяет.
  assert.deepEqual(feed.map((deed) => deed.kind), ['murder', 'arson'])
  assert.ok(feed[0].at_minutes > feed[1].at_minutes)
  // Подпись вида и число свидетелей приходят посчитанными.
  assert.deepEqual(feed.map((deed) => deed.label), ['Убийство', 'Поджог'])
  for (const deed of feed) assert.equal(deed.witness_count, deed.witness_ids.length)
  assert.equal(feed[1].witness_count, 2)

  // Игроку летописи нет вовсе: карточка у него пуста по построению.
  const player = campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  assert.equal(player.world_deeds, undefined)
})

test('у каждого вида поступка есть русская подпись в серверном каталоге', () => {
  for (const [kind, definition] of Object.entries(DEED_KINDS)) {
    assert.match(definition.label ?? '', /^[А-ЯЁ][а-яё ]+$/u, `вид поступка ${kind} остался без русской подписи`)
  }
})

test('лента поступков и слухов живёт в админке и подписана по-русски', () => {
  assert.match(views, /<WorldDeedsCard state=\{state\} \/>/u)
  assert.match(views, /admin-card admin-deeds/u)
  assert.match(views, /Поступки и слухи/u)
  // Секрет и молва — разные состояния карточки, и оба обязаны быть видны.
  assert.match(views, /БЕЗ СВИДЕТЕЛЕЙ/u)
  assert.match(views, /СВИДЕТЕЛЕЙ: \$\{deed\.witness_count \?\? 0\}/u)
  assert.match(views, /ВИДЕЛ САМ/u)
  assert.match(views, /ПЕРЕСКАЗ/u)
  // Подписи и порядок — серверные: своей таблицы и своей сортировки у карточки
  // быть не должно, иначе источников истины снова становится два.
  assert.doesNotMatch(views, /DEED_LABELS/u)
  assert.doesNotMatch(views, /world_deeds\?\.deeds[^\n]*\.sort\(/u)
})

test('карточки поступков и слухов оформлены и не ломают узкий экран', () => {
  assert.match(styles, /\.deed-feed article \{/u)
  assert.match(styles, /\.deed-feed article\.bright \{/u)
  assert.match(styles, /\.rumor-list li \{/u)
  assert.match(styles, /\.deed-feed article \{ grid-template-columns: 1fr; \}/u)
})
