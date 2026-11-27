import assert from 'node:assert/strict'
import test from 'node:test'

import { CRITICAL_NARRATION_TIMEOUT_MS, CriticalNarrationCoordinator, criticalMomentFor, heroFlourishFor } from '../server/creative-director.mjs'

const state = {
  scene: { title: 'Зал', location: 'Крепость', mood: 'Гулкий камень', objective: 'Выстоять' },
  players: [{ id: 'hero', character: 'Лира' }],
  enemies: [{ id: 'guard', name: 'Страж', hp: 0, maxHp: 12, alive: false }],
  actors: [],
}

test('creative director is completely bypassed for movement and ordinary attacks', async () => {
  let calls = 0
  const director = new CriticalNarrationCoordinator({ narrator: { render: async () => { calls += 1; return { narration: 'unexpected' } } } })
  const events = [
    { event_type: 'ActorMoved', actor_id: 'hero', target_ids: ['hero'], payload: { distance: 10 }, visibility: 'public' },
    { event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['guard'], payload: { total: 14, armor_class: 12, hit: true }, visibility: 'public' },
  ]
  assert.equal(criticalMomentFor(events, state), null)
  assert.equal(await director.renderCriticalMoment({ events, state }), null)
  assert.equal(calls, 0)
})

test('enemy death invokes creative narration only after the mechanical event is committed', async () => {
  let calls = 0
  const director = new CriticalNarrationCoordinator({ narrator: { render: async (brief, options) => {
    calls += 1
    assert.equal(brief.known_environment.critical_moment.kind, 'enemy_defeated')
    assert.equal(options.timeoutMs, CRITICAL_NARRATION_TIMEOUT_MS)
    return { narration: 'Страж оседает у расколотой колонны.', provider: 'fake-agent', verification: { valid: true }, suggestions: [] }
  } } })
  const events = [{ event_type: 'HitPointsReducedToZero', actor_id: 'hero', target_ids: ['guard'], payload: { hp_after: 0 }, visibility: 'public' }]
  const result = await director.renderCriticalMoment({ events, state, viewer: { playerId: 'hero', partyIds: ['hero'], isPartyMember: true } })
  assert.equal(calls, 1)
  assert.equal(result.trigger.kind, 'enemy_defeated')
  assert.match(result.narration, /Страж/u)
})

test('hero fall is not narrated as death, while committed HeroDied is final', async () => {
  const styles = []
  const director = new CriticalNarrationCoordinator({ narrator: { render: async (_brief, options) => {
    styles.push(options.style)
    return { narration: 'Переломный момент.', provider: 'fake-agent', verification: { valid: true }, suggestions: [] }
  } } })
  const state = { players: [{ id: 'hero', character: 'Лира' }], enemies: [{ id: 'wolf', name: 'Волк' }] }
  const fallen = await director.renderCriticalMoment({ events: [{ event_type: 'HitPointsReducedToZero', actor_id: 'wolf', target_ids: ['hero'], payload: {} }], state })
  const died = await director.renderCriticalMoment({ events: [{ event_type: 'HeroDied', actor_id: 'hero', target_ids: ['hero'], payload: { hero_name: 'Лира' } }], state })
  assert.equal(fallen.trigger.kind, 'hero_fallen')
  assert.match(styles[0], /не объявлен мёртвым/u)
  assert.equal(died.trigger.kind, 'hero_died')
  assert.match(styles[1], /окончательной смерти/u)
})

test('критическая реплика получает недавние реплики рассказчика для проверки повторов', async () => {
  // Плейтест 2026-10-10: одна и та же фраза-заполнитель прозвучала дважды за
  // бой — проверка повторов рассказчика не видела ни одной прежней реплики.
  const seen = []
  const director = new CriticalNarrationCoordinator({ narrator: { render: async (_brief, options) => {
    seen.push(options.recentNarrations)
    return { narration: 'Страж оседает.', provider: 'fake-agent', verification: { valid: true }, suggestions: [] }
  } } })
  const events = [{ event_type: 'HitPointsReducedToZero', actor_id: 'hero', target_ids: ['guard'], payload: {}, visibility: 'public' }]
  await director.renderCriticalMoment({ events, state, recentNarrations: ['Тишина звенит в ушах.', '', null] })
  assert.deepEqual(seen[0], ['Тишина звенит в ушах.'])
  await director.renderCriticalMoment({ events, state })
  assert.deepEqual(seen[1], [], 'без истории — пустой список, а не undefined')
})

test('без живого текста модели критический момент получает реплику о самом моменте, а не повтор строки боя', async () => {
  // Плейтест 2026-10-10: запасной рассказчик писал «Борин поражает Гоблина.
  // Гоблин получает урон» сразу под той же строкой боя.
  const director = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Борин поражает Гоблина. Гоблин получает урон.', provider: 'deterministic-fallback' }) } })
  const state = { players: [{ id: 'borin', character: 'Борин' }], enemies: [{ id: 'gob', name: 'Гоблин 1' }] }
  const events = [{ event_id: 'down-1', event_type: 'HitPointsReducedToZero', actor_id: 'borin', target_ids: ['gob'], payload: {} }]
  const result = await director.renderCriticalMoment({ events, state })
  assert.doesNotMatch(result.narration, /получает урон|поражает/u)
  assert.match(result.narration, /Гоблин 1/u)
  assert.equal((await director.renderCriticalMoment({ events, state })).narration, result.narration, 'тот же момент — та же строка')
  const live = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Гоблин падает в мокрую траву.', provider: 'RouterAI' }) } })
  assert.equal((await live.renderCriticalMoment({ events, state })).narration, 'Гоблин падает в мокрую траву.')
})

test('слова игрока к ходу в бою зовут рассказчика одной репликой о поступке; без слов — нет', async () => {
  // Замеры 2026-10-10: «Борин рычит «За Илу!» и рубит с плеча» ложилось
  // отдельной репликой, а следом — сухая строка боя; судья: «не учтены слова
  // игрока, бой — лента бросков».
  const state = { players: [{ id: 'borin', character: 'Борин' }], enemies: [{ id: 'gob', name: 'Гоблин 1' }], mechanics: { combat: { active: true } } }
  const events = [{ event_id: 'hit-1', event_type: 'AttackResolved', actor_id: 'borin', target_ids: ['gob'], payload: { hit: true } }]
  assert.equal(heroFlourishFor(events, state, { playerNote: '', actorId: 'borin' }), null, 'без слов — строка боя')
  assert.equal(heroFlourishFor(events, { ...state, mechanics: { combat: { active: false } } }, { playerNote: 'За Илу!', actorId: 'borin' }), null, 'вне боя — свой путь')
  assert.equal(heroFlourishFor(events, state, { playerNote: 'За Илу!', actorId: 'mirel' }), null, 'слова — к своему поступку')
  assert.equal(heroFlourishFor(events, state, { playerNote: 'Борин рычит «За Илу!» и рубит с плеча', actorId: 'borin' })?.kind, 'hero_flourish')

  const briefs = []
  const live = new CriticalNarrationCoordinator({ narrator: { render: async (brief) => { briefs.push(brief); return { narration: '«За Илу!» — клинок Борина обрушивается на гоблина.', provider: 'RouterAI' } } } })
  const told = await live.renderCriticalMoment({ events, state, playerNote: 'Борин рычит «За Илу!» и рубит с плеча', actorId: 'borin' })
  assert.equal(told.trigger.kind, 'hero_flourish')
  assert.match(told.narration, /За Илу/u)
  assert.equal(briefs[0].known_environment.player_intent.action, 'Борин рычит «За Илу!» и рубит с плеча')
  const silent = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Борин атакует Гоблина 1.', provider: 'deterministic-fallback' }) } })
  assert.equal((await silent.renderCriticalMoment({ events, state, playerNote: 'За Илу!', actorId: 'borin' })).narration, '', 'без живого текста — без дубля строки боя')
})

test('после победы — сцена после схватки; без живого текста — ничего', async () => {
  const state = { players: [{ id: 'borin', character: 'Борин' }], enemies: [{ id: 'gob', name: 'Гоблин 1' }], scene: { location: 'Маяк', objective: 'Найти, кто зажигает огонь' }, mechanics: { combat: { active: false } } }
  const victory = [{ event_id: 'out-1', event_type: 'EncounterOutcomeRecorded', payload: { outcome: 'enemies_defeated', plan: { secret: 'не для рассказчика' } } }]
  const briefs = []
  const live = new CriticalNarrationCoordinator({ narrator: { render: async (brief) => { briefs.push(brief); return { narration: 'Тишина возвращается к маяку; дождь смывает кровь с камней.', provider: 'RouterAI' } } } })
  assert.match((await live.renderAftermath({ events: victory, state })).narration, /Тишина/u)
  assert.doesNotMatch(JSON.stringify(briefs[0].visible_events), /не для рассказчика/u, 'план награды в бриф не идёт')
  const silent = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Встреча завершилась.', provider: 'deterministic-fallback' }) } })
  assert.equal(await silent.renderAftermath({ events: victory, state }), null)
})

test('после поражения без смертей — сцена: враги ушли, отряд очнулся; без чисел и выдуманных спасителей', async () => {
  // Замер 32 (2026-10-12): «Мирель приходит в сознание с 1 ОЗ… герои отдыхают
  // 12 часов… Небо затянуто, но сухо» — судья: кто спас, почему враги ушли.
  const state = { players: [{ id: 'borin', character: 'Борин' }], enemies: [{ id: 'cult', name: 'Культист' }], scene: { location: 'Маяк', objective: 'Найти, кто зажигает огонь' }, mechanics: { combat: { active: false } } }
  const events = [
    { event_id: 'out-d', event_type: 'EncounterOutcomeRecorded', payload: { outcome: 'party_incapacitated' } },
    { event_id: 'fled-d', event_type: 'ConditionAdded', target_ids: ['cult'], payload: { condition: 'fled' } },
    { event_id: 'poison-d', event_type: 'ConditionAdded', target_ids: ['borin'], payload: { condition: 'poisoned' } },
    { event_id: 'rest-d', event_type: 'DowntimeResolved', payload: { reason: 'post_defeat_recovery', duration_minutes: 720 } },
  ]
  const briefs = []
  const styles = []
  const live = new CriticalNarrationCoordinator({ narrator: { render: async (brief, options) => { briefs.push(brief); styles.push(options.style); return { narration: 'Борин открывает глаза на мокрых камнях: культистов нет, над морем светает.', provider: 'RouterAI' } } } })
  const told = await live.renderAftermath({ events, state })
  assert.equal(told.trigger.kind, 'defeat_aftermath')
  assert.match(styles[0], /без чисел/u)
  assert.match(styles[0], /Не выдумывай спасителя/u)
  assert.deepEqual(briefs[0].visible_events.map((event) => event.event_type), ['EncounterOutcomeRecorded', 'ConditionAdded', 'DowntimeResolved'], 'отравление — не повод сцены, бегство врага — повод')
  const silent = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Отряд отдыхает.', provider: 'deterministic-fallback' }) } })
  assert.equal(await silent.renderAftermath({ events, state }), null, 'без живого текста — прежняя строка')
})

test('гибель героя: рассказчик видит только сам момент и карточку героя, без смены хода', async () => {
  // Замер 9 (2026-10-10): «Мирель погибает, и её ход заканчивается; ход
  // переходит к Борину» — в бриф шли события очереди, и гибель звучала как
  // строка очереди. Теперь — удар, спасброски, гибель и предыстория героя.
  const briefs = []
  const director = new CriticalNarrationCoordinator({ narrator: { render: async (brief) => {
    briefs.push(brief)
    return { narration: 'Мирель затихает на мокрых камнях.', provider: 'fake-agent', verification: { valid: true }, suggestions: [] }
  } } })
  const state = {
    scene: { title: 'Скала', location: 'Маяк' },
    players: [
      { id: 'hero-1', character: 'Мирель', backstory: 'Ищет пропавшую сестру Илу.' },
      { id: 'hero-2', character: 'Борин' },
    ],
    enemies: [{ id: 'gob', name: 'Гоблин' }],
  }
  const events = [
    { event_type: 'DeathSavingThrowResolved', actor_id: 'hero-1', target_ids: ['hero-1'], payload: { result: 'died' } },
    { event_type: 'HeroDied', actor_id: 'hero-1', target_ids: ['hero-1'], payload: {} },
    { event_type: 'TurnEnded', actor_id: 'hero-1', target_ids: [], payload: {} },
    { event_type: 'TurnStarted', actor_id: 'hero-2', target_ids: [], payload: { round: 4 } },
  ]
  const died = await director.renderCriticalMoment({ events, state })
  assert.equal(died.trigger.kind, 'hero_died')
  const types = briefs[0].visible_events.map((event) => event.event_type)
  assert.deepEqual(types, ['DeathSavingThrowResolved', 'HeroDied'])
  assert.equal(briefs[0].known_environment.fallen_hero?.name, 'Мирель')
  assert.match(briefs[0].known_environment.fallen_hero?.backstory ?? '', /Илу/u)
})

test('начало схватки — абзац ведущего без номеров в именах; без модели — прежняя строка', async () => {
  // Замер 10: «Из укрытий выскакивают Волк 1 и Разбойник 1. Бой начинается» —
  // судья читал это как стат-блок.
  const briefs = []
  const director = new CriticalNarrationCoordinator({ narrator: { render: async (brief, options) => {
    briefs.push({ brief, options })
    return { narration: 'Из-за мокрых валунов выходит разбойник с арбалетом, а за ним, припав к земле, — тощий волк.', provider: 'fake-agent', verification: { valid: true }, suggestions: [] }
  } } })
  const events = [{ event_type: 'EncounterCreated', payload: { encounter: { theme: 'ambush', enemies: [{ name: 'Волк 1' }, { name: 'Разбойник 1' }] } } }]
  const opening = await director.renderEncounterOpening({ events, state })
  assert.match(opening.narration, /разбойник с арбалетом/u)
  assert.deepEqual(briefs[0].brief.known_environment.encounter_foes, ['Волк', 'Разбойник'])
  assert.match(briefs[0].options.style, /без номеров/u)
  const quiet = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Засада!', provider: 'deterministic-mechanics' }) } })
  assert.equal(await quiet.renderEncounterOpening({ events, state }), null)
  assert.equal(await director.renderEncounterOpening({ events: [], state }), null)
  // Замер 32: «дверь не поддаётся» — и засада из ниоткуда. Вводка знает, что
  // герой сделал только что, и связывает появление врагов с этим.
  await director.renderEncounterOpening({ events, state, lastPlayerAction: 'Борин толкает дверь плечом и первым входит внутрь' })
  assert.equal(briefs.at(-1).brief.known_environment.just_happened, 'Борин толкает дверь плечом и первым входит внутрь')
  assert.match(briefs.at(-1).options.style, /just_happened/u)
  assert.equal(briefs[0].brief.known_environment.just_happened, undefined)
})

test('после схватки, где пал герой, сцена начинается с павшего; падение — зов к товарищу', async () => {
  // Замер 27 (2026-10-11): Мирель погибла, а «после боя» звучало так, будто
  // ничего не случилось; её падение — одна строка без зова на помощь.
  const state = {
    players: [{ id: 'mirel', character: 'Мирель', hp: 0, maxHp: 20, backstory: 'Ищет сестру Илу.' }, { id: 'borin', character: 'Борин', hp: 12, maxHp: 31 }],
    enemies: [{ id: 'gob', name: 'Гоблин 1', hp: 0 }],
    scene: { location: 'Маяк', objective: 'Найти, кто зажигает огонь' },
    mechanics: { combat: { active: false }, death: { heroes: { mirel: { status: 'dead' } } } },
  }
  const briefs = []
  const styles = []
  const narrator = { render: async (brief, options) => { briefs.push(brief); styles.push(options?.style ?? ''); return { narration: 'Мирель лежит у порога маяка; Борин не двигается.', provider: 'RouterAI' } } }
  const live = new CriticalNarrationCoordinator({ narrator })
  await live.renderAftermath({ events: [{ event_id: 'out-2', event_type: 'EncounterOutcomeRecorded', payload: { outcome: 'enemies_defeated' } }], state })
  const fallen = briefs[0].known_environment.fallen_heroes
  assert.equal(fallen?.length, 1)
  assert.equal(fallen[0].condition, 'погиб')
  assert.match(JSON.stringify(fallen[0]), /Мирель/u)
  assert.match(styles[0], /fallen_heroes/u)

  const falling = { ...state, players: [{ ...state.players[0] }, state.players[1]], mechanics: { combat: { active: true }, death: { heroes: {} } } }
  await live.renderCriticalMoment({ events: [{ event_id: 'zero', event_type: 'HitPointsReducedToZero', actor_id: 'gob', target_ids: ['mirel'], payload: { successes: 0, failures: 0 } }], state: falling })
  assert.match(styles.at(-1), /успеешь/u, 'падение героя кончается зовом к товарищу')
})

test('критический удар героя или по герою — сцена; крит врага по врагу и обычное попадание — строка боя', async () => {
  // Владелец, 2026-10-12: на ключевые действия — слова ведущего, а не сухие
  // цифры; на каждый обычный удар — по-прежнему строка боя.
  const state = { players: [{ id: 'borin', character: 'Борин' }], enemies: [{ id: 'gob', name: 'Гоблин' }, { id: 'wolf', name: 'Волк' }], mechanics: { combat: { active: true } } }
  const crit = (actor, target) => [{ event_id: `crit-${actor}`, event_type: 'AttackResolved', actor_id: actor, target_ids: [target], payload: { hit: true, critical: true, target_id: target } }]
  assert.equal(criticalMomentFor(crit('borin', 'gob'), state)?.kind, 'critical_hit')
  assert.equal(criticalMomentFor(crit('gob', 'borin'), state)?.kind, 'critical_hit', 'по герою — тоже момент')
  assert.equal(criticalMomentFor(crit('gob', 'wolf'), state), null)
  assert.equal(criticalMomentFor([{ event_type: 'AttackResolved', actor_id: 'borin', target_ids: ['gob'], payload: { hit: true, critical: false } }], state), null)
  const styles = []
  const live = new CriticalNarrationCoordinator({ narrator: { render: async (_brief, options) => { styles.push(options.style); return { narration: 'Топор Борина входит под щит.', provider: 'RouterAI' } } } })
  assert.equal((await live.renderCriticalMoment({ events: crit('borin', 'gob'), state })).trigger.kind, 'critical_hit')
  assert.match(styles[0], /Без чисел/u)
  const silent = new CriticalNarrationCoordinator({ narrator: { render: async () => ({ narration: 'Борин наносит критический удар.', provider: 'deterministic-fallback' }) } })
  assert.equal((await silent.renderCriticalMoment({ events: crit('borin', 'gob'), state })).narration, '', 'без живого текста — строка боя уже всё сказала')
})

test('слова игрока к удару, который свалил врага, доходят до рассказчика', async () => {
  const state = { players: [{ id: 'borin', character: 'Борин' }], enemies: [{ id: 'gob', name: 'Гоблин' }], mechanics: { combat: { active: true } } }
  const events = [
    { event_id: 'hit-k', event_type: 'AttackResolved', actor_id: 'borin', target_ids: ['gob'], payload: { hit: true } },
    { event_id: 'down-k', event_type: 'HitPointsReducedToZero', actor_id: 'borin', target_ids: ['gob'], payload: {} },
  ]
  const briefs = []
  const live = new CriticalNarrationCoordinator({ narrator: { render: async (brief) => { briefs.push(brief); return { narration: '«За Илу!» — гоблин валится в камыш.', provider: 'RouterAI' } } } })
  const told = await live.renderCriticalMoment({ events, state, playerNote: 'Борин рычит «За Илу!»', actorId: 'borin' })
  assert.equal(told.trigger.kind, 'enemy_defeated')
  assert.equal(briefs[0].known_environment.player_intent.action, 'Борин рычит «За Илу!»')
  await live.renderCriticalMoment({ events, state, playerNote: 'Мирель шепчет молитву', actorId: 'mirel' })
  assert.equal(briefs[1].known_environment.player_intent, undefined, 'чужие слова к чужому удару не липнут')
})
