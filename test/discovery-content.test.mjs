// Сторож критерия 2 цели «Первый вечер без ведущего» (docs/playable-goal.md):
// удачная проверка познавательного навыка открывает содержательную находку.
//
// Плейтест 2026-10-02: Внимательность 23 против СЛ 15 у шлюзов Вельдбурга дала
// «новой зацепки нет». У авторского мира не было заготовок ведущего, запасная
// «зацепка» пересказывала саму заявку, а рассказчику запрещалось называть
// находки при успехе.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { narratorResponsePlan } from '../server/narrator.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { campaignStateForViewer, mechanicsForViewer, turnExplanationForViewer } from '../server/viewer-projection.mjs'
import { listWorldTemplates, worldTemplateOpening } from '../server/world-template-catalog.mjs'
import {
  applyWorldMemoryEvent,
  freeActionDiscoveryCommands,
  normalizeWorldMemory,
  validateWorldMemoryCommand,
  worldMemoryEvent,
  worldMemoryForViewer,
} from '../server/world-memory.mjs'

const hero = {
  id: 'hero', character: 'Брам', name: 'Игрок', role: 'Жрец · ур. 1',
  characterClass: 'cleric', level: 1, hp: 11, maxHp: 11, armor: 18, speed: 25,
  proficiency: 2, abilities: { str: 10, dex: 14, con: 15, int: 12, wis: 16, cha: 8 },
  inventory: [], x: 3, y: 2,
}

const check = (eventId = 'check-1', skill = 'perception') => ({ event_id: eventId, event_type: 'AbilityCheckResolved', payload: { success: true, skill } })

function commit(state, commands) {
  let memory = normalizeWorldMemory(state.worldMemory)
  for (const [index, raw] of commands.entries()) {
    const command = validateWorldMemoryCommand({ ...raw, command_id: `found:${index + 1}` }, { ...state, worldMemory: memory }, { isDirector: true })
    memory = applyWorldMemoryEvent(memory, { ...worldMemoryEvent(command), event_id: `found-event:${index + 1}`, command_id: command.command_id })
  }
  return { ...state, worldMemory: memory }
}

test('у каждого авторского мира есть заготовки ведущего для первой сцены', () => {
  const ids = listWorldTemplates().map((template) => template.id)
  assert.ok(ids.length >= 4)
  for (const id of ids) {
    const opening = worldTemplateOpening(id)
    assert.ok(opening.secrets.length >= 3, `${id}: заготовок меньше трёх`)
    const names = new Set(opening.npcs.map((npc) => npc.name))
    for (const secret of opening.secrets) {
      assert.ok(secret.clue.length >= 40, `${id}: заготовка «${secret.topic}» слишком короткая, чтобы быть находкой`)
      assert.ok(!secret.holder || names.has(secret.holder), `${id}: хранитель «${secret.holder}» не стоит в сцене`)
    }
  }
})

test('публичный список миров не выдаёт заготовки ведущего', () => {
  const listing = JSON.stringify(listWorldTemplates())
  const raw = JSON.parse(readFileSync(new URL('../data/campaign-worlds-v1.json', import.meta.url), 'utf8'))
  for (const template of raw.templates) {
    for (const secret of template.opening.secrets) assert.equal(listing.includes(secret.clue), false, `${template.id}: секрет в публичном списке`)
  }
})

test('кампания по авторскому миру хранит заготовки скрытыми, а игрок их не видит', async () => {
  const state = await new CampaignBootstrapper().create({ code: 'TIDES-SECRETS', worldTemplateId: 'league-nine-tides', players: [hero] })
  const secrets = state.worldMemory.facts.filter((fact) => fact.predicate === 'gm_secret')
  assert.equal(secrets.length, 4)
  assert.ok(secrets.every((fact) => fact.visibility === 'gm_only'))
  const mara = state.social.npcs.find((npc) => npc.name === 'Мара Трижды-Мерная')
  assert.ok(secrets.some((fact) => mara.known_fact_ids.includes(fact.id)), 'хранитель знает свой секрет и может выдать его в разговоре')
  const visible = JSON.stringify(worldMemoryForViewer(state.worldMemory, { isPartyMember: true }))
  for (const fact of secrets) assert.equal(visible.includes(fact.summary), false, 'секрет утёк игроку')
})

test('живая фраза плейтеста у шлюзов открывает заготовку, а не пустую зацепку', async () => {
  const state = await new CampaignBootstrapper().create({ code: 'TIDES-SLUICE', worldTemplateId: 'league-nine-tides', players: [hero] })
  const commands = freeActionDiscoveryCommands(state, {
    checkEvent: check(),
    skill: 'perception',
    actionText: 'Проталкиваюсь сквозь толпу к шлюзам и смотрю, кто пытается их открыть',
    goalSummary: 'Добраться сквозь толпу к шлюзам и заметить, кто пытается их открыть',
  })
  assert.equal(commands.length, 1)
  assert.match(commands[0].fact.summary, /ключ-воротка с клеймом Совета Когов/u)
  assert.doesNotMatch(commands[0].fact.summary, /удачная проверка/u)
  const after = commit(state, commands)
  const found = worldMemoryForViewer(after.worldMemory, { isPartyMember: true }).facts.find((fact) => fact.predicate === 'discovery')
  assert.match(found.summary, /Совета Когов/u, 'находка видна отряду')
})

function sceneWithoutSecrets() {
  return normalizeState({
    scene: { location: 'Смотровая дамба', objective: 'Понять, кто открывает шлюзы' },
    social: { npcs: [
      { id: 'mara', name: 'Мара', role: 'смотрительница дамбы', location: 'Смотровая дамба', goals: ['удержать людей подальше от главного шлюза', 'найти тех, кто подменил карту прилива'] },
      { id: 'oswald', name: 'Освальд', role: 'купец', location: 'Вельдбург', goals: ['не пускать никого к шлюзу'] },
      { id: 'ghost', name: 'Тень', role: 'тайный враг', location: 'Смотровая дамба', visibility: 'gm_only', goals: ['открыть шлюз ночью'] },
    ] },
    worldMemory: {
      entities: [{ id: 'location:dam', kind: 'location', name: 'Смотровая дамба', visibility: 'public' }],
      quests: [],
      facts: [],
    },
  })
}

function normalizeState(state) {
  return { ...state, worldMemory: normalizeWorldMemory(state.worldMemory) }
}

test('без заготовки удачный поиск называет знающего собеседника из сцены', () => {
  const state = sceneWithoutSecrets()
  const input = { checkEvent: check('check-lead'), skill: 'perception', actionText: 'Смотрю, кто возится у шлюза' }
  const [command] = freeActionDiscoveryCommands(state, input)
  assert.ok(command, 'успех обязан дать находку')
  assert.equal(command.fact.subject_id, 'location:dam')
  assert.match(command.fact.summary, /^Мара, смотрительница дамбы, явно знает об этом больше, чем говорит, — и хочет удержать людей подальше от главного шлюза\.$/u)
  assert.doesNotMatch(command.fact.summary, /Освальд|Тень/u, 'собеседник не из сцены и скрытый враг наводкой не становятся')

  // Та же цель второй раз не открывается: следующий успех — уже про другое.
  const after = commit(state, [command])
  const again = freeActionDiscoveryCommands(after, { ...input, checkEvent: check('check-lead-2') })
  assert.ok(again.every((entry) => !/удержать людей подальше/u.test(entry.fact.summary)))
  assert.deepEqual(freeActionDiscoveryCommands(state, { ...input, actionText: 'Смотрю на чаек над водой' }), [], 'без связи со сценой находка не выдумывается')
})

test('архитектор новой области приносит заготовки, но не хранителя и не лишнее', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { completeJson: async () => ({
    location: 'Затопленная часовня',
    secrets: [
      { clue: 'На алтаре свежий воск, хотя часовню затопило полвека назад: здесь молились этой ночью.', topic: 'алтарь воск свечи', skills: ['perception', 'athletics'], holder: 'Мара' },
      { clue: 'Под кафедрой спрятан ящик с картами прилива, подписанными чужой рукой.', topic: 'кафедра ящик карты', skills: ['investigation'] },
      { clue: 'коротко', topic: 'мусор', skills: [] },
      { clue: 'Четвёртый секрет сверх лимита не проходит, даже если длинный.', topic: 'лишний', skills: ['history'] },
      { clue: 'Пятый тоже лишний и тоже длинный, чтобы проверить срез.', topic: 'лишний', skills: ['history'] },
    ],
  }) } })
  const { sceneArgs } = await architect.plan({ state: { scene: { location: 'Вельдбург', objective: 'Найти часовню' } }, decision: 'Идём к часовне', destinationHint: 'Затопленная часовня' })
  assert.equal(sceneArgs.secrets.length, 2, 'короткая отбрасывается, сверх трёх не берётся')
  assert.deepEqual(sceneArgs.secrets[0].skills, ['perception'], 'Атлетика — не навык поиска')
  assert.ok(sceneArgs.secrets.every((secret) => secret.holder === ''), 'жителей сцены расставляет сервер, архитектор их не называет')
  const fallback = await new SceneArchitectAgent().plan({ state: { scene: { location: 'Вельдбург' } }, decision: 'Идём к часовне', destinationHint: 'Затопленная часовня' })
  assert.equal(fallback.sceneArgs.secrets, undefined, 'без модели заготовок не выдумываем')
})

test('переход в новую область прячет её заготовки, а удачный поиск там их открывает', () => {
  const initial = normalizeCampaignState({
    sessionCode: 'AREA-SECRETS', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Вельдбург', location: 'Вельдбург', mood: 'Тревога', objective: 'Найти часовню', turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }] },
    adventure: { chapter: 1, currentHook: 'Колокол звонит из часовни', unresolvedThreads: [], visitedLocations: ['Вельдбург'], history: [] },
  })
  const secrets = [
    { clue: 'На алтаре свежий воск, хотя часовню затопило полвека назад: здесь молились этой ночью.', topic: 'алтарь воск свечи', skills: ['perception'], holder: '' },
  ]
  const result = resolveCommands([{
    command_type: 'AdvanceScene',
    command_id: 'advance-chapel',
    scene_args: {
      title: 'Затопленная часовня', location: 'Затопленная часовня', mood: 'Капли с потолка', objective: 'Понять, кто звонит',
      hook: 'Колокол часовни молчит', transition: 'Отряд идёт к часовне.', arrival: 'Часовня стоит по колено в воде.',
      completed_objective: 'Найти часовню', objective_status: 'completed', outcome: 'Часовня найдена.', carry_unresolved: false,
      theme: 'затопленная часовня', danger: 'средняя', secrets,
    },
  }], initial, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { isAdmin: true } })

  const scene = result.events.find((event) => event.event_type === 'SceneAdvanced')
  assert.equal(JSON.stringify(scene.payload).includes('свежий воск'), false, 'заготовка не едет в публичном событии перехода')
  const secretEvent = result.events.find((event) => event.event_type === 'WorldFactRecorded' && event.payload?.fact?.predicate === 'gm_secret')
  assert.equal(secretEvent.visibility, 'gm_only')
  const chapel = result.state.worldMemory.entities.find((entity) => entity.name === 'Затопленная часовня')
  assert.equal(secretEvent.payload.fact.subject_id, chapel.id)

  const player = { role: 'player', heroIds: ['hero'] }
  assert.equal(JSON.stringify(campaignStateForViewer(result.state, player, 'hero')).includes('свежий воск'), false, 'тайна не видна в комнате')
  assert.equal(JSON.stringify(mechanicsForViewer(result.events, player, 'hero', result.state)).includes('свежий воск'), false, 'тайна не видна в событиях хода')
  const why = turnExplanationForViewer({ commands: [{ command_type: 'AdvanceScene', scene_args: { location: 'Затопленная часовня', secrets } }] }, player, 'hero', result.state)
  assert.equal(JSON.stringify(why).includes('свежий воск'), false, 'тайна не видна в разборе «Почему так?»')

  const [found] = freeActionDiscoveryCommands(result.state, { checkEvent: check('chapel-look'), skill: 'perception', actionText: 'Осматриваю алтарь и свечи' })
  assert.match(found.fact.summary, /свежий воск/u)
  assert.equal(found.fact.supersedes_fact_id, secretEvent.payload.fact.id)

  // Replay даёт ту же тайну и тот же id — заготовка не плодится на повторе.
  const replayed = replayEvents(initial, result.events)
  assert.deepEqual(replayed.worldMemory.facts.filter((fact) => fact.predicate === 'gm_secret'), result.state.worldMemory.facts.filter((fact) => fact.predicate === 'gm_secret'))
})

test('рассказчик обязан назвать находку, если она записана событием', () => {
  const plan = narratorResponsePlan({
    visible_events: [
      { event_type: 'AbilityCheckResolved', payload: { skill: 'perception', success: true } },
      { event_type: 'RulingRecorded', payload: { ruling: { outcome: 'success' } } },
      { event_type: 'WorldFactRecorded', payload: { fact: { predicate: 'discovery', summary: 'У шлюза двое в плащах купеческого дома.' } } },
    ],
  })
  assert.match(plan.must_answer, /назвать находку/u)
  const bare = narratorResponsePlan({ visible_events: [{ event_type: 'RulingRecorded', payload: { ruling: { outcome: 'success' } } }] })
  assert.match(bare.must_answer, /новых находок/u, 'без находки запрет на выдумку остаётся')
})
