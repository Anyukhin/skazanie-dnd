import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import {
  applyWorldMemoryEvent,
  freeActionDiscoveryCommands,
  normalizeWorldMemory,
  validateWorldMemoryCommand,
  worldMemoryEvent,
  worldMemoryForViewer,
} from '../server/world-memory.mjs'

// Заготовки ведущего: скрытые факты первой сцены, которые находит удачная
// проверка подходящего навыка или выдаёт знающий собеседник.

const hero = {
  id: 'nova', name: 'Анна', character: 'Нова', role: 'Плут · ур. 1', species: 'Человек',
  background: 'Шарлатан', backstory: 'Ищет брата.', speed: 30, maxHp: 12, armor: 13, online: true,
}

const opening = {
  campaignName: 'Журнал не того берега', partyName: 'Двое',
  worldSummary: 'Речной край с мытнями.',
  openingNarration: 'У мытни Клара Вельм прижимает к груди запертый футляр с картой.\n\nНа столе раскрыт журнал поисков.',
  scene: { title: 'Мытня', location: 'Мытарский Двор', mood: 'Дождливое утро', objective: 'Понять, почему искали не там', theme: 'мытня', danger: 'низкая', map: { layout: 'streets', width: 13, height: 11, openness: 0.6, water: 0, featureCount: 4 } },
  npcs: [{ name: 'Клара Вельм', role: 'хранительница карты', summary: 'Держит карту в футляре.', voice: 'Ровно.', goals: ['Сохранить порядок'], beliefs: ['Записи не лгут'] }],
  secrets: [
    { clue: 'На футляре свежая царапина от ножа: его уже вскрывали этой ночью.', topic: 'футляр карта замок', skills: ['investigation', 'perception'], holder: '' },
    { clue: 'Клара сама переписала отметки в журнале: её почерк на последних строках другой.', topic: 'журнал отметки почерк', skills: ['insight', 'investigation'], holder: 'Клара Вельм' },
    { clue: 'пусто', topic: 'не годится', skills: ['athletics'], holder: '' },
  ],
  hook: 'Почему искали не там',
}

async function campaign() {
  return new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(opening) }]) }).create({
    code: 'GM-SECRETS', name: 'Секреты', partyName: 'Двое', world: {}, players: [hero],
  })
}

function check(skill, eventId = 'check-1') {
  return { event_id: eventId, event_type: 'AbilityCheckResolved', payload: { success: true, skill } }
}

function commit(state, commands) {
  let memory = normalizeWorldMemory(state.worldMemory)
  for (const [index, raw] of commands.entries()) {
    const command = validateWorldMemoryCommand({ ...raw, command_id: `reveal:${index + 1}` }, { ...state, worldMemory: memory }, { isDirector: true })
    memory = applyWorldMemoryEvent(memory, { ...worldMemoryEvent(command), event_id: `reveal-event:${index + 1}`, command_id: command.command_id })
  }
  return { ...state, worldMemory: memory }
}

test('создание кампании сохраняет заготовки ведущего скрытыми фактами', async () => {
  const state = await campaign()
  const secrets = state.worldMemory.facts.filter((fact) => fact.predicate === 'gm_secret')
  // Пустая заготовка без текста отбрасывается, навык вне списка не проходит.
  assert.equal(secrets.length, 2)
  assert.ok(secrets.every((fact) => fact.visibility === 'gm_only' && fact.status === 'active'))
  assert.deepEqual(JSON.parse(secrets[0].object).skills, ['investigation', 'perception'])

  // Знает только названный хранитель.
  const klara = state.social.npcs.find((npc) => npc.name === 'Клара Вельм')
  assert.ok(klara.known_fact_ids.includes(secrets[1].id))
  assert.ok(!klara.known_fact_ids.includes(secrets[0].id))

  // Игрок секретов не видит; стартовых обещаний нет.
  const visible = worldMemoryForViewer(state.worldMemory, { playerId: 'nova', isPartyMember: true })
  assert.equal(visible.facts.some((fact) => fact.predicate === 'gm_secret'), false)
  assert.deepEqual(state.social.promises, [])
})

test('удачная проверка по теме открывает секрет фактом отряда и гасит тайну', async () => {
  const state = await campaign()
  const commands = freeActionDiscoveryCommands(state, {
    checkEvent: check('investigation'), skill: 'investigation', actionText: 'Изучаю футляр с картой',
  })
  assert.equal(commands.length, 1)
  const fact = commands[0].fact
  assert.equal(fact.predicate, 'discovery')
  assert.equal(fact.visibility, 'party')
  assert.match(fact.summary, /царапина от ножа/u)

  const after = commit(state, commands)
  const secret = after.worldMemory.facts.find((entry) => entry.id === fact.supersedes_fact_id)
  assert.equal(secret.status, 'superseded')
  const visible = worldMemoryForViewer(after.worldMemory, { playerId: 'nova', isPartyMember: true })
  assert.ok(visible.facts.some((entry) => entry.id === fact.id && /царапина/u.test(entry.summary)))

  // Тот же поиск второй раз ничего тайного уже не открывает.
  const again = freeActionDiscoveryCommands(after, {
    checkEvent: check('investigation', 'check-2'), skill: 'investigation', actionText: 'Изучаю футляр с картой',
  })
  assert.ok(again.every((command) => !command.fact?.supersedes_fact_id || command.fact.supersedes_fact_id !== secret.id))
})

test('секрет открывает только подходящий навык; общий осмотр награждает внимательность', async () => {
  const state = await campaign()
  // Атлетика не находит улик.
  assert.deepEqual(freeActionDiscoveryCommands(state, {
    checkEvent: check('athletics'), skill: 'athletics', actionText: 'Изучаю футляр',
  }), [])
  // Проницательность по теме журнала — секрет Клары.
  const insight = freeActionDiscoveryCommands(state, {
    checkEvent: check('insight'), skill: 'insight', actionText: 'Слежу, не врёт ли Клара про журнал',
  })
  assert.match(insight[0]?.fact?.summary ?? '', /почерк/u)
  // «Осматриваюсь» без темы: Внимательность находит секрет этого места.
  const look = freeActionDiscoveryCommands(state, {
    checkEvent: check('perception'), skill: 'perception', actionText: 'Осматриваюсь',
  })
  assert.match(look[0]?.fact?.summary ?? '', /футляре/u)
  // Провал не открывает ничего.
  assert.deepEqual(freeActionDiscoveryCommands(state, {
    checkEvent: { ...check('perception'), payload: { success: false, skill: 'perception' } }, skill: 'perception', actionText: 'Осматриваюсь',
  }), [])
})

test('пересказ найденной улики не считается новой вещью, уходом или репликой', async () => {
  const { buildNarrationBrief, verifyNarration } = await import('../server/security.mjs')
  const clue = 'Оттуда недавно забрали небольшой плоский предмет; список прибывающих переписан.'
  const briefWith = (events) => buildNarrationBrief({
    visible_events: events,
    known_environment: { player_intent: { action: 'Осматриваю ящик' }, structured_result: { outcome: 'check_success' }, story_context: { heroes: [{ id: 'nova', name: 'Нова' }] } },
  })
  const found = briefWith([
    { event_type: 'AbilityCheckResolved', actor_id: 'nova', visibility: 'public', payload: { success: true, skill: 'perception' } },
    { event_type: 'WorldFactRecorded', actor_id: 'nova', visibility: 'party', payload: { fact: { id: 'f1', predicate: 'discovery', visibility: 'party', summary: clue } } },
  ])
  const text = 'Нова замечает: оттуда недавно забрали небольшой плоский предмет, а список прибывающих кто-то переписал.'
  assert.deepEqual(verifyNarration(text, found).violations.map((entry) => entry.code), [])
  const nothing = briefWith([{ event_type: 'AbilityCheckResolved', actor_id: 'nova', visibility: 'public', payload: { success: true, skill: 'perception' } }])
  assert.ok(verifyNarration(text, nothing).violations.some((entry) => entry.code === 'ITEM_TRANSFER_NOT_IN_BRIEF'))
})

test('поиск следов находит следы, а не соседний секрет того же места', async () => {
  const state = await campaign()
  const tracksFact = {
    id: 'fact:secret:tracks', subject_id: state.worldMemory.facts.find((fact) => fact.predicate === 'gm_secret').subject_id,
    predicate: 'gm_secret', object: JSON.stringify({ topic: 'следы телега дорога', skills: ['survival'], holder: '' }),
    summary: 'У колодца видны следы тяжёлых сапог, остановившиеся у телеги.', visibility: 'gm_only',
    source_event_ids: [], source_command_id: 'test', supersedes_fact_id: '', status: 'active', recorded_at_minutes: 0,
  }
  const withTracks = { ...state, worldMemory: { ...state.worldMemory, facts: [...state.worldMemory.facts, tracksFact] } }
  // Внимательность, но герой прямо называет следы у телеги: родственный навык поиска находит их.
  const found = freeActionDiscoveryCommands(withTracks, {
    checkEvent: check('perception'), skill: 'perception', actionText: 'Ищу следы у колодца и телеги',
  })
  assert.equal(found[0]?.fact?.supersedes_fact_id, 'fact:secret:tracks')
})
