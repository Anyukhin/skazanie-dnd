import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import {
  applyWorldMemoryEvent,
  freeActionDiscoveryCommands,
  freeActionSurfaceCommands,
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

// Прогон Асстохана 2026-10-07: тайна лагеря ждала Проницательности или
// Анализа, и удачная Внимательность у обелиска, как и удачное «иду по
// следам» с Выживанием, не давали ничего. Общий поиск открывает тайну этого
// места и родственным навыком поиска.
test('общий поиск родственным навыком открывает тайну места, если своей нет', async () => {
  const state = await campaign()
  const [scratch] = state.worldMemory.facts.filter((fact) => fact.predicate === 'gm_secret')
  const onlyJournal = { ...state, worldMemory: { ...state.worldMemory, facts: state.worldMemory.facts.map((fact) => fact.id === scratch.id ? { ...fact, status: 'superseded' } : fact) } }
  for (const [skill, actionText] of [['perception', 'Осматриваю обелиск и символы на нём'], ['survival', 'Иду по следам, которые мы нашли, и пытаюсь понять, куда они ведут']]) {
    const found = freeActionDiscoveryCommands(onlyJournal, { checkEvent: check(skill, `check-${skill}`), skill, actionText })
    assert.match(found[0]?.fact?.summary ?? '', /почерк/u, `${skill}: ${actionText}`)
  }
  // Навык вне поиска (Атлетика) по-прежнему ничего не открывает.
  assert.deepEqual(freeActionDiscoveryCommands(onlyJournal, { checkEvent: check('athletics'), skill: 'athletics', actionText: 'Осматриваюсь' }), [])
})

test('удачный поиск отвечает на заданный вопрос, а не открывает соседнюю тайну по одному общему слову', async () => {
  // Плейтест 2026-10-10: «ищу метку владельца на корме» сходилось с чужим
  // секретом по одной основе и открывало его вместо ответа; метку так и не
  // назвали. Деталь, названная арбитром до броска, становится находкой.
  const state = await campaign()
  const detail = 'На корме выжжена чайка с перебитым крылом — так метят лодки семьи Ворониных.'
  const commands = freeActionDiscoveryCommands(state, {
    checkEvent: check('investigation', 'detail-check'), skill: 'investigation',
    actionText: 'Осматриваю корму баркаса и ищу метку владельца', successDetail: detail,
  })
  const summaries = commands.map((command) => command.fact.summary)
  assert.ok(summaries.includes(detail), 'ответ на вопрос записан находкой')
  const recorded = commit(state, commands)
  assert.ok(worldMemoryForViewer(recorded.worldMemory, { isPartyMember: true }).facts.some((fact) => fact.summary === detail))
  // Повтор того же хода не записывает деталь второй раз.
  const again = freeActionDiscoveryCommands(recorded, {
    checkEvent: check('investigation', 'detail-check-2'), skill: 'investigation',
    actionText: 'Осматриваю корму баркаса и ищу метку владельца', successDetail: detail,
  })
  assert.ok(!again.some((command) => command.fact.summary === detail))
})

test('тема заготовки сильнее детали: вопрос о футляре открывает тайну футляра', async () => {
  const state = await campaign()
  const commands = freeActionDiscoveryCommands(state, {
    checkEvent: check('investigation', 'case-check'), skill: 'investigation',
    actionText: 'Осматриваю футляр с картой и его замок', successDetail: 'На футляре клеймо мастерской.',
  })
  assert.equal(commands.length, 1)
  assert.match(commands[0].fact.summary, /царапина от ножа/u)
})

test('проваленный осмотр показывает видимую деталь места, а пустая удача — её же вместо пустоты', async () => {
  // Плейтест 2026-10-10: «Осмотреть баркас не удалось: ничего нового» — без
  // единой детали. Что видно и без броска, называет арбитр (`surface_detail`).
  const state = await campaign()
  const surface = 'Сеть на корме сложена аккуратно, будто её укладывали на берегу, а не в море.'
  const failed = { event_id: 'failed-look', event_type: 'AbilityCheckResolved', payload: { success: false, skill: 'perception' } }
  const [seen] = freeActionSurfaceCommands(state, { checkEvent: failed, skill: 'perception', surfaceDetail: surface })
  assert.equal(seen?.fact?.summary, surface)
  assert.equal(seen.fact.object, 'surface')
  assert.equal(seen.fact.visibility, 'party')
  assert.ok(!JSON.stringify(seen).includes('царапина'), 'тайна сцены не раскрывается')
  assert.deepEqual(freeActionSurfaceCommands(state, { checkEvent: failed, skill: 'athletics', surfaceDetail: surface }), [], 'только поиск')

  const emptyLuck = freeActionDiscoveryCommands({ ...state, worldMemory: { ...state.worldMemory, facts: [] } }, {
    checkEvent: check('perception', 'lucky-look'), skill: 'perception', actionText: 'Смотрю на воду', surfaceDetail: surface,
  })
  assert.deepEqual(emptyLuck.map((command) => command.fact.summary), [surface])
})

test('общий осмотр не открывает чужого свидетельства и не срабатывает на «прислушиваюсь»', async () => {
  // Плейтест 2026-10-10: «прислушиваюсь у двери маяка» и «смотрю на вершину
  // маяка» открывали тайну места не о том, а наблюдение — «Йорен Келл видел,
  // как…»: показания, которые даёт человек, а не место.
  const state = await campaign()
  const location = state.worldMemory.entities.find((entity) => entity.name === state.scene.location)
  const testimony = { id: 'fact:secret:witness', subject_id: location.id, predicate: 'gm_secret', status: 'active', visibility: 'gm_only',
    object: JSON.stringify({ topic: 'канат стражник', skills: ['perception', 'insight'], holder: 'Йорен Келл' }),
    summary: 'Йорен Келл видел, как стражник с баронским жетоном помог незнакомцам перерезать канат.', recorded_at_minutes: 0 }
  const onlyTestimony = { ...state, worldMemory: { ...state.worldMemory, facts: [...state.worldMemory.facts.map((fact) => fact.predicate === 'gm_secret' ? { ...fact, status: 'superseded' } : fact), testimony] } }
  const looked = freeActionDiscoveryCommands(onlyTestimony, { checkEvent: check('perception', 'look-around'), skill: 'perception', actionText: 'Осматриваюсь у причала' })
  assert.ok(!looked.some((command) => /Йорен/u.test(command.fact?.summary ?? '')), 'свидетельство не находится осмотром')
  const listened = freeActionDiscoveryCommands(state, { checkEvent: check('perception', 'listen'), skill: 'perception', actionText: 'Прислушиваюсь у двери, есть ли кто-то внутри' })
  assert.ok(!listened.some((command) => /царапина|почерк/u.test(command.fact?.summary ?? '')), 'прислушаться — не обыск')
})

test('свидетельство по теме открывается, только когда герой обращается к его хранителю', async () => {
  // Замер 2026-10-10: Мирель следила за реакцией Эды на иллюзию, а удача
  // открыла «Орен признаётся: видел такую же зарубку» — показания другого.
  const state = await campaign()
  const location = state.worldMemory.entities.find((entity) => entity.name === state.scene.location)
  const testimony = { id: 'fact:secret:witness-topic', subject_id: location.id, predicate: 'gm_secret', status: 'active', visibility: 'gm_only',
    object: JSON.stringify({ topic: 'зарубка баркас', skills: ['insight', 'perception'], holder: 'Орен Вейл' }),
    summary: 'Орен Вейл видел такую же зарубку на другом баркасе, но молчал.', recorded_at_minutes: 0 }
  const only = { ...state, worldMemory: { ...state.worldMemory, facts: [...state.worldMemory.facts.map((fact) => fact.predicate === 'gm_secret' ? { ...fact, status: 'superseded' } : fact), testimony] } }
  const watching = freeActionDiscoveryCommands(only, { checkEvent: check('insight', 'watch-eda'), skill: 'insight', actionText: 'Слежу, как Эда смотрит на зарубку на баркасе' })
  assert.ok(!watching.some((command) => /Орен/u.test(command.fact?.summary ?? '')))
  const askingHolder = freeActionDiscoveryCommands(only, { checkEvent: check('insight', 'read-oren'), skill: 'insight', actionText: 'Смотрю, как Орен отводит глаза, когда речь о зарубке на баркасе' })
  assert.ok(askingHolder.some((command) => /Орен/u.test(command.fact?.summary ?? '')))
})

test('удачная Проницательность без детали не подсовывает «X явно знает больше» о другом жителе', async () => {
  const state = await campaign()
  const quiet = { ...state, worldMemory: { ...state.worldMemory, facts: state.worldMemory.facts.filter((fact) => fact.predicate !== 'gm_secret') } }
  const read = freeActionDiscoveryCommands(quiet, { checkEvent: check('insight', 'read-face'), skill: 'insight', actionText: 'Слежу, как Клара смотрит на журнал' })
  assert.ok(!read.some((command) => /явно знает об этом больше/u.test(command.fact?.summary ?? '')))
})

test('тщательный поиск вне спешки: провал броска стоит времени, а спрятанное находится', async () => {
  // Замер 10 (2026-10-10): «стена отказов» — три проваленных осмотра подряд
  // и ни одной улики, хотя заготовки лежали рядом. Правило «Многократные
  // проверки» (DMG 2014, гл. 8): вдесятеро больше времени — успех без броска.
  const { thoroughSearchOutcome, isThoroughSearch, THOROUGH_SEARCH_MINUTES } = await import('../server/world-memory.mjs')
  const state = await campaign()
  const failed = { event_id: 'check-thorough', event_type: 'AbilityCheckResolved', payload: { success: false, skill: 'investigation' } }
  assert.equal(isThoroughSearch('Методично осматриваю футляр, каждую щель'), true)
  assert.equal(isThoroughSearch('Быстро осматриваю футляр'), false)
  const found = thoroughSearchOutcome(state, { checkEvent: failed, skill: 'investigation', actionText: 'Методично осматриваю футляр и замок' })
  assert.equal(found?.found, true)
  assert.equal(found.minutes, THOROUGH_SEARCH_MINUTES)
  assert.match(found.commands[0].fact.summary, /царапина от ножа/u)
  assert.equal(thoroughSearchOutcome(state, { checkEvent: failed, skill: 'investigation', actionText: 'Осматриваю футляр' })?.found, true, 'обыск вне спешки — тщательный и без слова «методично» (замер 11)')
  assert.equal(thoroughSearchOutcome(state, { checkEvent: failed, skill: 'perception', actionText: 'Прислушиваюсь у двери' }), null, 'прислушаться — не обыск')
  const fighting = { ...state, mechanics: { ...state.mechanics, combat: { ...(state.mechanics?.combat ?? {}), active: true } } }
  assert.equal(thoroughSearchOutcome(fighting, { checkEvent: failed, skill: 'investigation', actionText: 'Методично осматриваю футляр' }), null, 'в бою спешка — правило не действует')
  const success = { ...failed, payload: { success: true, skill: 'investigation' } }
  assert.equal(thoroughSearchOutcome(state, { checkEvent: success, skill: 'investigation', actionText: 'Методично осматриваю футляр' }), null)
})

test('заготовка, которую NPC уже рассказал, не находится поиском второй раз', async () => {
  const state = await campaign()
  const secret = state.worldMemory.facts.find((fact) => fact.predicate === 'gm_secret' && /футляр/u.test(fact.summary))
  const lucky = check('investigation', 'check-told')
  assert.ok(freeActionDiscoveryCommands(state, { checkEvent: lucky, skill: 'investigation', actionText: 'Осматриваю футляр и замок' })
    .some((command) => command.fact?.summary === secret.summary), 'без разговора заготовка находится')
  const ledger = { ...state, worldMemory: { ...state.worldMemory, knowledge_ledger: [{ id: 'k1', fact_id: secret.id, hero_id: 'nova' }] } }
  assert.ok(!freeActionDiscoveryCommands(ledger, { checkEvent: lucky, skill: 'investigation', actionText: 'Осматриваю футляр и замок' })
    .some((command) => command.fact?.summary === secret.summary), 'названная в разговоре заготовка не повторяется')
  const retold = { ...state, social: { ...(state.social ?? {}), conversations: [{ id: 'c1', npc_id: 'npc', npc_reply: 'На футляре свежая царапина от ножа — его уже вскрывали этой ночью, клянусь.', disclosed_fact_ids: [] }] } }
  assert.ok(!freeActionDiscoveryCommands(retold, { checkEvent: lucky, skill: 'investigation', actionText: 'Осматриваю футляр и замок' })
    .some((command) => command.fact?.summary === secret.summary), 'пересказанная почти дословно заготовка тоже')
})

test('удачная Проницательность — реакция того, за кем следили, а не тайна места', async () => {
  const state = await campaign()
  const reaction = 'Клара бледнеет и прижимает футляр к груди — вопрос ей неприятен.'
  const found = freeActionDiscoveryCommands(state, {
    checkEvent: check('insight', 'check-insight'), skill: 'insight',
    actionText: 'Слежу за лицом Клары, когда спрашиваю про журнал и отметки', successDetail: reaction,
  })
  assert.deepEqual(found.map((command) => command.fact?.summary), [reaction])
})

test('удачная Проницательность без реакции от судьи читает правду о человеке', async () => {
  // Замеры 10–11: «по её взгляду не понять, узнала ли» — ответ провала на
  // удачу. Правда выводится из заготовок, хранитель которых — этот человек;
  // сама тайна не раскрывается.
  const { insightRead } = await import('../server/world-memory.mjs')
  const state = await campaign()
  const here = state.scene?.location_id
  const withKlara = { ...state, scene_npcs: [{ id: 'klara', name: 'Клара Вельм', location_id: here, alive: true }, { id: 'tom', name: 'Том Рыбак', location_id: here, alive: true }] }
  const knows = insightRead(withKlara, { actionText: 'Спрашиваю Клару про журнал и слежу за её лицом' })
  assert.match(knows, /Клара Вельм знает об этом больше, чем говорит/u)
  assert.doesNotMatch(knows, /почерк/u, 'тайна не раскрывается')
  assert.match(insightRead(withKlara, { actionText: 'Слежу за лицом Клары, когда говорю о погоде на реке' }), /скрывает — только, похоже, не это/u)
  assert.match(insightRead(withKlara, { actionText: 'Слежу за Томом, когда спрашиваю про журнал' }), /не притворяется/u)
  assert.equal(insightRead(withKlara, { actionText: 'Слежу за лицом незнакомца' }), '')
  const found = freeActionDiscoveryCommands(withKlara, { checkEvent: check('insight', 'check-read'), skill: 'insight', actionText: 'Спрашиваю Клару про журнал и слежу за её лицом' })
  assert.deepEqual(found.map((command) => command.fact?.summary), [knows])
})
