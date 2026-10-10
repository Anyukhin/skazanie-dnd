// Граница знания NPC, антиповтор, встречная зацепка и карточка героя в брифе
// собеседника. Партия «Серый Причал» (плейтест 2026-10-10): хозяин таверны
// пересказывал находку отряда на пирсе, рыбачка трижды говорила одну фразу,
// отказ назвать владельца баркаса никуда не вёл, а сестру волшебника, пропавшую
// в море, не вспомнил никто.
import assert from 'node:assert/strict'
import test from 'node:test'

import { NpcSocialController, freshReplyText } from '../server/npc-social-controller.mjs'
import { npcKnownFactIds } from '../server/npc-social.mjs'
import { resolveCommand } from '../server/rules-engine.mjs'
import { UNTRUSTED_DATA_END, UNTRUSTED_DATA_START } from '../server/security.mjs'
import { dice } from './kit/dice.mjs'
import { scriptedLlm } from './kit/llm.mjs'

const MARK = 'На борту баркаса выжжен знак — рыба с тремя глазами.'
const OWNER_CLUE = 'Баркас «Чайка» ушёл к маяку той ночью без огней, и правил им чужак.'
const PIER_CLUE = 'Под настилом пирса спрятан ящик с сетями чужаков.'
const EMPTY_BOAT = 'Баркас пришёл пустой на рассвете, и никто не видел, кто его пригнал.'

function untrustedPayload(content, section) {
  const open = `${UNTRUSTED_DATA_START}:${section}>>>`
  const close = `${UNTRUSTED_DATA_END}:${section}>>>`
  const start = content.indexOf(open)
  const end = content.indexOf(close)
  assert.ok(start >= 0 && end > start, `блок UNTRUSTED_DATA:${section} обязан присутствовать`)
  return JSON.parse(content.slice(start + open.length, end))
}

/** Отряд начал в таверне, сходил на пирс (там нашёл знак) и вернулся в таверну. */
function greyPier() {
  return {
    sessionCode: 'GREY-PIER',
    partyMemberIds: ['wizard', 'fighter'],
    scene: { title: 'Таверна «Сеть»', location: 'Таверна «Сеть»', objective: 'Узнать, чей пустой баркас прибило к пирсу' },
    mechanics: { world_time: { elapsed_minutes: 60 }, combat: { active: false } },
    players: [
      {
        id: 'wizard', character: 'Тарвин', role: 'Волшебник · ур. 1', characterClass: 'wizard', background: 'Мудрец',
        backstory: 'Три месяца назад моя сестра Ила ушла в море и не вернулась. С тех пор я ищу любой её след.',
        bonds: 'Найду Илу, чего бы это ни стоило.', characterSetupRequired: false,
      },
      {
        id: 'fighter', character: 'Гарет', role: 'Воин · ур. 1', characterClass: 'fighter', background: 'Стражник',
        backstory: 'Бывший стражник. Капитан велел не замечать ночных лодок у маяка.', bonds: '', characterSetupRequired: false,
      },
    ],
    worldMemory: {
      entities: [
        { id: 'loc:tavern', kind: 'location', name: 'Таверна «Сеть»', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'loc:pier', kind: 'location', name: 'Пирс Серого Причала', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'loc:lighthouse', kind: 'location', name: 'Старый маяк', summary: '', aliases: [], visibility: 'party', tags: [] },
      ],
      facts: [
        { id: 'fact:opening', subject_id: 'loc:tavern', predicate: 'opening_narration', object: 'Пролог', summary: 'В таверне «Сеть» пахнет рыбой и дымом.', visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 0 },
        { id: 'fact:arrive-pier', subject_id: 'loc:pier', predicate: 'party_arrived', object: 'Пирс', summary: 'Отряд на пирсе.', visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 20 },
        { id: 'fact:found-mark', subject_id: 'loc:pier', predicate: 'discovery', object: 'clue', summary: MARK, visibility: 'party', status: 'active', source_event_ids: ['event:search'], recorded_at_minutes: 30 },
        { id: 'fact:arrive-tavern', subject_id: 'loc:tavern', predicate: 'party_arrived', object: 'Таверна', summary: 'Отряд вернулся в таверну.', visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 50 },
        {
          id: 'fact:secret:owner', subject_id: 'loc:tavern', predicate: 'gm_secret',
          object: JSON.stringify({ topic: 'чей баркас «Чайка»', skills: ['investigation', 'insight'], holder: 'Борс' }),
          summary: OWNER_CLUE, visibility: 'gm_only', status: 'active', source_event_ids: [], recorded_at_minutes: 0,
        },
      ],
      epistemic_claims: [],
    },
    social: {
      npcs: [
        { id: 'npc:bors', name: 'Борс', role: 'трактирщик', location: 'Таверна «Сеть»', public_summary: 'Держит таверну у воды.', voice: 'Басит, отвечает коротко.', visibility: 'party', available: true, known_fact_ids: ['fact:opening'] },
        { id: 'npc:helga', name: 'Хельга', role: 'рыбачка', location: 'Пирс Серого Причала', public_summary: 'Чинит сети на пирсе.', voice: 'Говорит быстро, ворчливо.', visibility: 'party', available: true, known_fact_ids: [] },
        { id: 'npc:maren', name: 'Марен', role: 'смотритель маяка', location: 'Старый маяк', public_summary: 'Живёт на маяке один.', voice: 'Тихий, медленный.', visibility: 'party', available: true, known_fact_ids: [] },
      ],
      relationships: {},
      conversations: [],
      promises: [],
    },
  }
}

const offline = () => new NpcSocialController()
const replyWith = (reply, extra = {}) => ({ reply, stance: 'neutral', disclosed_fact_ids: [], disclosed_claim_ids: [], relationship_delta: 0, ...extra })

test('NPC не знает находки отряда, которой не видел, и не пересказывает её', async () => {
  const state = greyPier()
  assert.equal(npcKnownFactIds(state, state.social.npcs[0]).has('fact:found-mark'), false, 'трактирщик был в таверне, а знак нашли на пирсе')

  const llm = scriptedLlm([replyWith('Знак? Не видел никакого знака.')])
  await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:bors', message: 'Что за знак на борту баркаса — рыба с тремя глазами?', turnId: 'bors-mark',
  })
  const brief = untrustedPayload(llm.calls[0].input.messages[1].content, 'npc_social_brief')
  assert.equal(brief.speakable_facts.some((fact) => fact.id === 'fact:found-mark'), false)
  assert.doesNotMatch(JSON.stringify(brief.speakable_facts), /выжжен знак/u)

  const fallback = await offline().respond({
    state, playerId: 'wizard', npcId: 'npc:bors', message: 'Что за знак выжжен на борту баркаса?', turnId: 'bors-mark-offline',
  })
  assert.doesNotMatch(fallback.reply, /выжжен|тремя глазами/u, fallback.reply)
})

test('находку, сделанную у него на глазах, NPC знает', async () => {
  const state = greyPier()
  assert.equal(npcKnownFactIds(state, state.social.npcs[1]).has('fact:found-mark'), true, 'рыбачка стояла на пирсе, когда нашли знак')
  const llm = scriptedLlm([replyWith('Знак тот я видела.')])
  await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Что за знак на борту баркаса?', turnId: 'helga-mark',
  })
  const brief = untrustedPayload(llm.calls[0].input.messages[1].content, 'npc_social_brief')
  assert.ok(brief.speakable_facts.some((fact) => fact.id === 'fact:found-mark'))
})

test('отказ ведёт к хранителю тайны: зацепка без текста тайны и с моделью, и без неё', async () => {
  const state = greyPier()
  const llm = scriptedLlm([replyWith('Не моё это дело.')])
  await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Кто правил «Чайкой» той ночью?', turnId: 'helga-owner',
  })
  const brief = untrustedPayload(llm.calls[0].input.messages[1].content, 'npc_social_brief')
  assert.deepEqual(brief.leads[0], {
    kind: 'person', match: 'question', name: 'Борс', role: 'трактирщик', where: 'Таверна «Сеть»', about: 'чей баркас «Чайка»',
  })
  assert.doesNotMatch(JSON.stringify(brief), /без огней|правил им чужак/u, 'текст тайны в бриф не идёт')

  const fallback = await offline().respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Кто правил «Чайкой» той ночью?', turnId: 'helga-owner-offline',
  })
  assert.match(fallback.reply, /не сообщает ничего нового, но подсказывает: «Об этом больше знает Борс, трактирщик/u)
  assert.doesNotMatch(fallback.reply, /без огней|чужак/u)
})

test('хранитель сам по вопросу о своей тайне называет цену, а удачное убеждение её открывает', async () => {
  const state = greyPier()
  const guarded = await offline().respond({
    state, playerId: 'wizard', npcId: 'npc:bors', message: 'Чей это баркас «Чайка»?', turnId: 'bors-owner',
  })
  assert.match(guarded.reply, /просто так такое не рассказывают/u)
  assert.deepEqual(guarded.disclosed_fact_ids, [])
  assert.equal(guarded.visibility, 'party')

  const persuaded = await offline().respond({
    state, playerId: 'wizard', npcId: 'npc:bors', message: 'Чей это баркас «Чайка»?', turnId: 'bors-owner-check',
    checkOutcome: { skill: 'persuasion', ability: 'cha', success: true, degree: 'success' },
  })
  assert.equal(persuaded.reply, `Борс сдаётся: «${OWNER_CLUE}»`)
  assert.deepEqual(persuaded.disclosed_fact_ids, ['fact:secret:owner'])
  assert.equal(persuaded.visibility, 'specific_player', 'раскрытая тайна звучит только тому, кто её добыл')
})

test('реплика личная только когда тайна действительно прозвучала', async () => {
  const state = greyPier()
  const silent = await new NpcSocialController({ llmClient: scriptedLlm([replyWith('Не твоё дело, чей баркас.')]) }).respond({
    state, playerId: 'wizard', npcId: 'npc:bors', message: 'Чей это баркас «Чайка»?', turnId: 'bors-silent',
  })
  assert.equal(silent.visibility, 'party', 'тайна была среди кандидатов, но не прозвучала')

  const told = await new NpcSocialController({ llmClient: scriptedLlm([replyWith('Ушла «Чайка» к маяку без огней, чужак правил.', { disclosed_fact_ids: ['fact:secret:owner'] })]) }).respond({
    state, playerId: 'wizard', npcId: 'npc:bors', message: 'Чей это баркас «Чайка»?', turnId: 'bors-told',
  })
  assert.equal(told.visibility, 'specific_player')
  // Хранитель назван в самой заготовке, а не в known_fact_ids: проверка
  // разговора сервером принимает и такое знание.
  const recorded = resolveCommand({ command_type: 'RecordNpcSocialTurn', actor_id: 'wizard', conversation: told.conversation }, state, {
    diceService: dice(), context: { isSocialController: true },
  })
  assert.ok(recorded.events.some((event) => event.event_type === 'KnowledgeRevealed' && event.payload.fact_id === 'fact:secret:owner'))
})

test('тайна места без хранителя достаётся одному жителю этого места', async () => {
  const state = greyPier()
  state.scene = { ...state.scene, title: 'Пирс', location: 'Пирс Серого Причала' }
  state.worldMemory.facts.push({
    id: 'fact:secret:pier', subject_id: 'loc:pier', predicate: 'gm_secret',
    object: JSON.stringify({ topic: 'тайник под пирсом', skills: ['investigation'], holder: '' }),
    summary: PIER_CLUE, visibility: 'gm_only', status: 'active', source_event_ids: [], recorded_at_minutes: 0,
  })
  assert.equal(npcKnownFactIds(state, state.social.npcs[1]).has('fact:secret:pier'), true, 'рыбачка — единственная на пирсе')
  assert.equal(npcKnownFactIds(state, state.social.npcs[0]).has('fact:secret:pier'), false)
  const told = await new NpcSocialController({ llmClient: scriptedLlm([replyWith('Под настилом ящик чужаков лежит.', { disclosed_fact_ids: ['fact:secret:pier'] })]) }).respond({
    state, playerId: 'fighter', npcId: 'npc:helga', message: 'Что спрятано под пирсом?', turnId: 'helga-pier',
  })
  assert.deepEqual(told.disclosed_fact_ids, ['fact:secret:pier'])
  const recorded = resolveCommand({ command_type: 'RecordNpcSocialTurn', actor_id: 'fighter', conversation: told.conversation }, state, {
    diceService: dice(), context: { isSocialController: true },
  })
  assert.ok(recorded.events.some((event) => event.event_type === 'KnowledgeRevealed'))
})

test('повтор прежней реплики вырезается, даже если она была сказана другому герою наедине', async () => {
  const state = greyPier()
  state.social.conversations.push({
    id: 'conv:helga:fighter', npc_id: 'npc:helga', hero_id: 'fighter', player_message: 'Что тут случилось?',
    npc_reply: EMPTY_BOAT, stance: 'neutral', visibility: 'specific_player',
  })
  const llm = scriptedLlm([replyWith(`${EMPTY_BOAT} Сети в нём были сухие.`)])
  const result = await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Что с этим баркасом?', turnId: 'helga-repeat-private',
  })
  assert.equal(result.reply, 'Сети в нём были сухие.')
  assert.equal(result.repetition, 'trimmed')
  assert.equal(llm.calls.length, 1)
  const brief = untrustedPayload(llm.calls[0].input.messages[1].content, 'npc_social_brief')
  assert.doesNotMatch(JSON.stringify(brief.already_said), /пришёл пустой/u, 'чужая личная беседа в бриф не идёт')
})

test('ответ целиком из повтора — одна повторная попытка со списком сказанного', async () => {
  const state = greyPier()
  state.social.conversations.push({
    id: 'conv:helga:fighter', npc_id: 'npc:helga', hero_id: 'fighter', player_message: 'Что тут случилось?',
    npc_reply: EMPTY_BOAT, stance: 'neutral', visibility: 'party',
  })
  const llm = scriptedLlm([replyWith(EMPTY_BOAT), replyWith('Я уже говорила. А вот сети в нём были сухие, будто их не бросали.')])
  const result = await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Что с этим баркасом?', turnId: 'helga-regenerate',
  })
  assert.equal(llm.calls.length, 2)
  assert.equal(result.repetition, 'regenerated')
  assert.equal(result.reply, 'Я уже говорила. А вот сети в нём были сухие, будто их не бросали.')
  const retry = untrustedPayload(llm.calls[1].input.messages[1].content, 'npc_social_brief')
  assert.equal(retry.repeat_retry, true)
  assert.deepEqual(retry.already_said, [EMPTY_BOAT])
})

test('и повторная попытка повторяет — короткое признание и зацепка вместо третьего повтора', async () => {
  const state = greyPier()
  state.social.conversations.push({
    id: 'conv:helga:fighter', npc_id: 'npc:helga', hero_id: 'fighter', player_message: 'Что тут случилось?',
    npc_reply: EMPTY_BOAT, stance: 'neutral', visibility: 'party',
  })
  const llm = scriptedLlm([replyWith(EMPTY_BOAT), replyWith(`Ну так ${EMPTY_BOAT.toLocaleLowerCase('ru')}`)])
  const result = await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Кто пригнал баркас «Чайку»?', turnId: 'helga-acknowledge',
  })
  assert.equal(result.repetition, 'acknowledged')
  assert.equal(result.reply, 'Всё, что знаю, вы уже слышали. Об этом больше знает Борс, трактирщик — ищите там: Таверна «Сеть».')
  assert.deepEqual(result.disclosed_fact_ids, [])
})

test('проверка повтора не трогает новое и короткое', () => {
  assert.deepEqual(freshReplyText('Слушаю.', [EMPTY_BOAT]), { text: 'Слушаю.', dropped: 0 })
  assert.deepEqual(freshReplyText(`Да. ${EMPTY_BOAT}`, [EMPTY_BOAT]), { text: '', dropped: 1 })
  // Почти то же другими словами порядка — тоже повтор.
  assert.equal(freshReplyText('Пустой баркас пришёл на рассвете, никто не видел, кто его пригнал.', [EMPTY_BOAT]).text, '')
  assert.equal(freshReplyText('Баркас мой, и ночью его угнали.', [EMPTY_BOAT]).dropped, 0)
})

test('карточка героя приходит в бриф собеседника внутри UNTRUSTED_DATA', async () => {
  const llm = scriptedLlm([replyWith('Сестру ищешь? Слыхал я про «Чайку».')])
  await new NpcSocialController({ llmClient: llm }).respond({
    state: greyPier(), playerId: 'wizard', npcId: 'npc:bors', message: 'Я ищу сестру, Илу. Ты её видел?', turnId: 'bors-sister',
  })
  const [system, user] = llm.calls[0].input.messages
  const brief = untrustedPayload(user.content, 'npc_social_brief')
  assert.equal(brief.speaking_hero.name, 'Тарвин')
  assert.equal(brief.speaking_hero.class, 'Волшебник')
  assert.equal(brief.speaking_hero.background, 'Мудрец')
  assert.match(brief.speaking_hero.backstory, /сестра Ила ушла в море/u)
  assert.equal(brief.speaking_hero.bonds, 'Найду Илу, чего бы это ни стоило.')
  assert.ok(brief.speaking_hero.backstory.length <= 300)
  assert.doesNotMatch(system.content, /сестра Ила/u, 'предыстория игрока — данные, а не системный текст')
  assert.doesNotMatch(Object.keys(brief.speaking_hero).join(' '), /secret|unrevealed/u)
})

test('знаток, которого отряд уже расспрашивал, помечен и не идёт первой отсылкой по кругу', async () => {
  // Плейтест 2026-10-10: Мара отсылала к Ивену, Ивен — к Маре, и так по кругу.
  const state = greyPier()
  state.social.conversations.push({ id: 'conversation:bors-1', npc_id: 'npc:bors', hero_id: 'wizard', visibility: 'party', player_message: 'Чей это баркас «Чайка»?', npc_reply: 'Не знаю.', stance: 'neutral' })
  const llm = scriptedLlm([replyWith('Не моё это дело.')])
  await new NpcSocialController({ llmClient: llm }).respond({
    state, playerId: 'wizard', npcId: 'npc:helga', message: 'Кто правил «Чайкой» той ночью?', turnId: 'helga-owner-again',
  })
  const brief = untrustedPayload(llm.calls[0].input.messages[1].content, 'npc_social_brief')
  const bors = brief.leads.find((lead) => lead.name === 'Борс')
  assert.equal(bors?.asked_before, true)
})
