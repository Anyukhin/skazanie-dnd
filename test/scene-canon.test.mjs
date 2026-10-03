import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import { Narrator, sensoryAnchorsFor } from '../server/narrator.mjs'
import {
  SCENE_CANON_CONTRADICTION,
  campaignStartCanon,
  sceneCanonContradictions,
  sceneCanonFor,
  sceneCanonFromEnvironment,
} from '../server/scene-canon.mjs'
import { UNTRUSTED_DATA_END, UNTRUSTED_DATA_START, assertNarrationBrief, buildNarrationBrief, verifyNarration } from '../server/security.mjs'
import { dayPhaseLabel, weatherConditionLabel, weatherConditionSummary } from '../server/weather.mjs'
import { getWorldTemplate, listWorldTemplates, worldTemplateOpening } from '../server/world-template-catalog.mjs'

const hero = {
  id: 'ada', name: 'Игрок', character: 'Ада', role: 'Следопыт · ур. 1', species: 'Человек',
  background: 'Проводница', backstory: 'Водила караваны.', speed: 30, maxHp: 12, armor: 13, online: true,
}

const pierOpening = {
  campaignName: 'Солёные сваи', partyName: 'Отряд',
  worldSummary: 'Портовый город на сваях.',
  openingNarration: 'Утро над причалом Аквилона серое и тихое. Ада ждёт у сходней.',
  scene: {
    title: 'Причал Аквилона', location: 'Причал Аквилона', mood: 'Тревожное ожидание', objective: 'Найти пропавший груз',
    theme: 'портовый причал на сваях', danger: 'низкая',
    map: { layout: 'streets', scale: 'site', pattern: 'village', material: 'wood', width: 17, height: 11, openness: 0.6, water: 0.2, featureCount: 4 },
  },
  hook: 'Пропавший груз',
  worldMap: {
    name: 'Побережье',
    // Меньше трёх регионов карта мира не принимает и подставляет свои.
    regions: [
      { name: 'Солёное побережье', biome: 'coast', x: 500, y: 320, radius: 200 },
      { name: 'Сухие холмы', biome: 'plains', x: 200, y: 150, radius: 150 },
      { name: 'Туманные топи', biome: 'marsh', x: 800, y: 500, radius: 150 },
    ],
    locations: [
      { name: 'Причал Аквилона', kind: 'port', region: 'Солёное побережье', x: 500, y: 320, summary: 'Порт.', known: true, visited: true },
      { name: 'Маяк', kind: 'landmark', region: 'Солёное побережье', x: 700, y: 200, summary: 'Маяк.', known: true, visited: false },
    ],
    routes: [{ from: 'Причал Аквилона', to: 'Маяк', kind: 'road', distance: 3, danger: 'низкая', discovered: true }],
  },
  npcs: [{ name: 'Иара', role: 'смотрительница причала', summary: 'Следит за сходнями.', voice: 'Коротко', goals: ['Найти груз'], beliefs: ['Порядок важнее'] }],
}

function untrustedPayload(content, section) {
  const open = `${UNTRUSTED_DATA_START}:${section}>>>`
  const close = `${UNTRUSTED_DATA_END}:${section}>>>`
  const start = content.indexOf(open)
  const end = content.indexOf(close)
  assert.ok(start >= 0 && end > start, `блок ${section} обязан присутствовать`)
  return JSON.parse(content.slice(start + open.length, end))
}

async function pierCampaign() {
  const llm = new FakeLLM([{ content: JSON.stringify(pierOpening) }])
  const state = await new CampaignBootstrapper({ llmClient: llm }).create({
    code: 'CANON-PIER', name: 'Солёные сваи', partyName: 'Отряд', world: { startingLocation: 'Причал Аквилона' }, players: [hero],
  })
  return { state, llm }
}

/** world_clock в той форме, в которой его кладёт оркестратор. */
function worldClock({ phase = 'morning', clock = '08:00', weather = 'clear', indoors = false } = {}) {
  return {
    day: 1, clock, time_of_day: phase, time_of_day_label: dayPhaseLabel(phase),
    weather, weather_label: weatherConditionLabel(weather), weather_summary: weatherConditionSummary(weather), indoors, effects: [],
  }
}

function canon(options = {}) {
  return sceneCanonFromEnvironment({ world_clock: worldClock(options), scene: { location: 'Причал Аквилона' } })
}

function briefWith(environment, events = []) {
  return buildNarrationBrief({
    known_environment: environment, visible_events: events, visible_state_changes: [], permitted_npc_reactions: [],
    viewer: { playerId: 'ada', isPartyMember: true },
  })
}


test('канон стартовой сцены: утро 08:00, небо края, порт у воды, материалы карты', async () => {
  const { state } = await pierCampaign()
  const result = sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' })
  assert.equal(result.time.clock, '08:00')
  assert.equal(result.time.phase, 'morning')
  assert.equal(result.location.kind, 'port')
  assert.equal(result.location.biome, 'coast')
  assert.equal(result.surfaces.water_nearby, true)
  assert.ok(result.surfaces.materials.length >= 1, 'открытые клетки карты дают хотя бы один материал')
  // Небо канона — то же, что сервер заранее обещал автору кампании для этого края.
  assert.equal(result.weather.id, campaignStartCanon(state.worldMap.seed).weather_by_biome.coast.id)
  assert.deepEqual(result.present.heroes, ['Ада'])
  assert.ok(result.present.npcs.includes('Иара'))
  assert.match(result.summary, /Утро, 08:00/u)
})

test('канон показывает только то, что видит зритель', async () => {
  const { state } = await pierCampaign()
  const locationId = state.scene.location_id
  state.social.npcs.push(
    { id: 'npc-secret', name: 'Тайный наблюдатель', location_id: locationId, location: state.scene.location, available: true, visibility: 'gm_only' },
    { id: 'npc-whisper', name: 'Шептун', location_id: locationId, location: state.scene.location, available: true, visibility: 'specific_player', player_id: 'ada' },
  )
  state.enemies = [{ id: 'lurker', name: 'Скрытый убийца', hp: 9, alive: true, visibility: 'gm_only' }, { id: 'thug', name: 'Громила', hp: 9, alive: true }]
  const forAda = sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' })
  const forOther = sceneCanonFor(state, { playerId: 'ren', actorId: 'ada' })
  assert.ok(forAda.present.npcs.includes('Шептун'))
  assert.ok(!forOther.present.npcs.includes('Шептун'))
  for (const value of [forAda, forOther]) {
    assert.ok(!JSON.stringify(value).includes('Тайный наблюдатель'))
    assert.ok(!JSON.stringify(value).includes('Скрытый убийца'))
    assert.ok(value.present.creatures.includes('Громила'))
  }
  // Канон проходит проекцию для Рассказчика без потерь и без закрытых ключей.
  const brief = briefWith({ scene: { location: state.scene.location }, scene_canon: forAda })
  assertNarrationBrief(brief)
  assert.deepEqual(brief.known_environment.scene_canon, forAda)
})

test('канон из world_clock: без часов проверки нет, а не угадывание', () => {
  assert.equal(sceneCanonFromEnvironment({ scene: { location: 'Причал' } }), null)
  const fromClock = canon({ phase: 'night', clock: '01:00', weather: 'rain' })
  assert.equal(fromClock.light.level, 'dark')
  assert.equal(fromClock.surfaces.wetness, 'wet')
  assert.equal(fromClock.surfaces.water_nearby, true, 'причал узнаётся по названию места')
  const verdict = verifyNarration('Ночь стоит тихая, туман глушит шаги.', briefWith({ scene: { location: 'Причал' } }))
  assert.equal(verdict.violations.some((violation) => violation.code === SCENE_CANON_CONTRADICTION), false)
})

test('verifier ловит живые противоречия 2026-10-01: ночь в восемь утра и пыль на мокром причале', () => {
  const morningClear = worldClock()
  const fogPier = worldClock({ weather: 'fog' })
  const night = verifyNarration('Аквилон встречает ночь туманом: над причалом висит сырая мгла.', briefWith({ scene: { location: 'Причал Аквилона' }, world_clock: morningClear }))
  assert.ok(night.violations.some((violation) => violation.code === SCENE_CANON_CONTRADICTION && /ночь/u.test(violation.match)))
  const dust = verifyNarration('Доски причала покрыты пылью, перила скрипят.', briefWith({ scene: { location: 'Причал Аквилона' }, world_clock: fogPier }))
  assert.ok(dust.violations.some((violation) => violation.code === SCENE_CANON_CONTRADICTION && /пыль/u.test(violation.match)))
})

test('verifier ловит погоду, небо под крышей и время суток', () => {
  const cases = [
    ['Дождь барабанит по навесу над прилавками.', canon({ weather: 'clear' })],
    ['Безоблачное небо открывает вид на дальние башни.', canon({ weather: 'fog' })],
    ['Отряд сидит у очага, а над головами мерцают звёзды.', canon({ phase: 'night', clock: '01:00', indoors: true })],
    ['Солнце стоит высоко, и камни мостовой нагрелись.', canon({ phase: 'night', clock: '01:00' })],
    ['Рассветные лучи касаются мокрой черепицы.', canon({ phase: 'evening', clock: '19:00' })],
    ['Закатное солнце окрашивает стены часовни в медь.', canon()],
  ]
  for (const [text, value] of cases) {
    assert.ok(sceneCanonContradictions(text, value).length > 0, text)
  }
})

test('verifier не трогает речь, прошлое, сравнения, отрицания, окна и далёкое небо', () => {
  const cases = [
    ['— Ночь будет долгой, — бурчит стражник у ворот.', canon()],
    ['Мира говорит: «Прошлой ночью здесь шёл дождь».', canon()],
    ['Прошлой ночью кто-то сорвал замок; теперь видны свежие царапины.', canon()],
    ['После ночного дождя доски ещё влажные, но небо чистое.', canon()],
    ['Тёмный, как ночь, плащ незнакомца не шевелится.', canon()],
    ['В голове у Рена туман после вчерашней попойки.', canon()],
    ['Небо затянуто серой пеленой, но дождя нет.', canon({ weather: 'overcast', phase: 'day', clock: '13:00' })],
    ['Никакого тумана — тракт виден до самых холмов.', canon({ phase: 'day', clock: '13:00' })],
    ['Отряд сидит у очага; за окном мерцают звёзды.', canon({ phase: 'night', clock: '01:00', indoors: true })],
    ['Если начнётся дождь, следы на глине пропадут.', canon()],
    ['Небо серое и сухое, но дождь пока держится за морем.', canon({ weather: 'overcast' })],
    ['Пыль на полках архива лежит нетронутой, пока снаружи льёт дождь.', canon({ weather: 'rain', phase: 'day', clock: '13:00', indoors: true })],
    ['Крышка ларца отходит с шорохом сухой пыли.', canon({ weather: 'rain', phase: 'day', clock: '13:00' })],
    ['Туман рассеивается, открывая реку.', canon()],
    ['Свежий слой пепла и ночной дождь съели края отпечатков.', canon()],
  ]
  for (const [text, value] of cases) {
    assert.deepEqual(sceneCanonContradictions(text, value), [], text)
  }
})

test('у границы суток и при смене часов слова соседней фазы честны', () => {
  // 05:10 — уже утро по часам, но ночная прохлада ещё держится.
  assert.deepEqual(sceneCanonContradictions('Ночная прохлада ещё держится над причалом.', canon({ clock: '05:10' })), [])
  assert.ok(sceneCanonContradictions('Ночная прохлада ещё держится над причалом.', canon({ clock: '08:00' })).length > 0)
  const changed = [{ event_type: 'TimeOfDayChanged', payload: { phase_before: 'night', phase_after: 'morning' } }]
  assert.deepEqual(sceneCanonContradictions('Ночь отступает, и над крышами светлеет.', canon(), { events: changed }), [])
  // Заклинание тумана законно приносит туман в ясный день.
  const fogSpell = [{ event_type: 'SpellCast', payload: { spell_id: 'fog-cloud', spell_name: 'Туманное облако' } }]
  assert.deepEqual(sceneCanonContradictions('Густой туман стелется по двору.', canon({ phase: 'day', clock: '13:00' }), { events: fogSpell }), [])
})

test('сенсорные якоря следуют канону: в тумане на причале нет пыли', () => {
  const scene = { location: 'Северные ворота', title: 'Северные ворота' }
  const plain = sensoryAnchorsFor(briefWith({ scene }))
  assert.equal(Object.keys(plain).length, 4, 'без часов якоря прежние')
  for (const weather of ['fog', 'rain', 'storm']) {
    const value = canon({ weather })
    const anchors = sensoryAnchorsFor(briefWith({ scene, world_clock: worldClock({ weather }) }))
    for (const anchor of Object.values(anchors)) {
      assert.deepEqual(sceneCanonContradictions(anchor, value), [], `${weather}: ${anchor}`)
      assert.doesNotMatch(anchor, /пыл/u)
    }
  }
  const night = sensoryAnchorsFor(briefWith({ scene, world_clock: worldClock({ phase: 'night', clock: '01:00', weather: 'clear' }) }))
  assert.match(night.light, /лун|звёзд/u)
})

test('Рассказчик получает канон отдельным блоком (с narrator/v11)', async () => {
  const llm = new FakeLLM([{ content: 'Туман лежит на досках причала.' }])
  const narrator = new Narrator({ llmClient: llm, asyncFeedback: false })
  await narrator.render(briefWith({ scene: { location: 'Причал Аквилона' }, world_clock: worldClock({ weather: 'fog' }) }))
  const [request] = llm.requests
  assert.match(request.messages[0].content, /PROMPT_ID: narrator\/v12/u)
  assert.match(request.messages[0].content, /scene_canon/u)
  const payload = untrustedPayload(request.messages[1].content, 'scene_canon')
  assert.equal(payload.weather, 'Туман')
  assert.equal(payload.clock, '08:00')
  assert.match(payload.surfaces, /сыро/u)
})

test('автор кампании получает серверные часы и небо первого утра по краям', async () => {
  const { state, llm } = await pierCampaign()
  const content = llm.requests[0].messages[1].content
  assert.match(llm.requests[0].messages[0].content, /PROMPT_ID: campaign_creator\/v8/u)
  const clock = untrustedPayload(content, 'starting_world_clock')
  assert.deepEqual(clock, { day: 1, clock: '08:00', time_of_day: 'morning', time_of_day_label: 'Утро' })
  const table = untrustedPayload(content, 'starting_weather_by_biome')
  assert.deepEqual(Object.keys(table).sort(), ['coast', 'desert', 'forest', 'marsh', 'mountains', 'plains', 'tundra', 'wastes'])
  const actual = sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' })
  assert.ok(table.coast.startsWith(actual.weather.label), 'обещанное автору небо совпадает с часами после создания')
})

test('готовые миры начинаются без противоречия утренним часам при любой погоде', () => {
  for (const summary of listWorldTemplates()) {
    const opening = worldTemplateOpening(getWorldTemplate(summary.id), { campaignName: 'Проверка', partyName: 'Отряд' })
    for (const weather of ['clear', 'overcast', 'rain', 'fog', 'storm']) {
      assert.deepEqual(sceneCanonContradictions(opening.openingNarration, canon({ weather })), [], `${summary.id}/${weather}`)
    }
  }
})

test('размеченный набор: полнота не ниже 0.8 и ни одного срабатывания на чистых текстах', () => {
  const { cases } = JSON.parse(readFileSync(new URL('../eval/scene-canon-cases-2026-10-01.json', import.meta.url), 'utf8'))
  const flagged = (entry) => sceneCanonContradictions(entry.text, canon(entry.canon)).length > 0
  const contradictions = cases.filter((entry) => entry.label === 'contradiction')
  const clean = cases.filter((entry) => entry.label === 'clean')
  assert.ok(contradictions.length >= 40 && clean.length >= 40)
  const recall = contradictions.filter(flagged).length / contradictions.length
  assert.ok(recall >= 0.8, `полнота ${recall}`)
  assert.deepEqual(clean.filter(flagged).map((entry) => entry.text), [])
})
