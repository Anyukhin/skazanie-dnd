import { createHash } from 'node:crypto'

/**
 * Парлей: переговоры посреди боя.
 *
 * За живым столом бой не обязан кончаться трупами. Кто-то кричит «стойте,
 * поговорим!», и дальше решает не кубик урона, а положение сторон: сколько у
 * них осталось, скольких они уже потеряли и кто вообще способен слушать. В
 * движке этой середины не было (`docs/dnd-table-situations.md`, C4): социальная
 * сцена в активном бою запрещена явно, а Убеждение свободным действием ничего
 * не прекращало.
 *
 * Модуль детерминированный и без обращений к модели, как `captives.mjs` и
 * `world-deeds.mjs`. Устроен он так:
 *
 * 1. **Отклик считает мораль стороны, а не бросок игрока.** Бросок Харизмы
 *    только сдвигает уже посчитанную серверную СЛ; сама СЛ выводится из доли
 *    оставшихся ОЗ противника и доли выбывших. Фанатики и бессловесные не
 *    отвечают вовсе — и это решается **до** броска, чтобы игрок не платил
 *    кубиком за заведомо невозможное.
 * 2. **Перемирие — состояние боя, а не пауза в UI.** `mechanics.combat.truce`
 *    замораживает очередь: планировщик ходов NPC на застывшем бое не работает,
 *    а любая атака рвёт перемирие и остаётся в летописи поступков вероломством.
 * 3. **Исход выбирается из закрытого серверного списка.** Что именно готов
 *    принять противник — уйти, оставить добычу, сдаться — решает та же мораль,
 *    а не клиент и не модель.
 *
 * Осознанные границы (решено, а не забыто):
 * - откуп считается **монетой**: сумма выводится из XP стат-блоков, уже
 *   лежащих в провенансе врага. Каталог предметов принадлежит другой задаче, и
 *   раздавать вещи отсюда нельзя;
 * - собеседником становится предводитель уцелевших, и профиль ему собирается
 *   тем же детерминированным приёмом, что и пленному (`captivePersona`), —
 *   второго генератора безымянных врагов в проекте быть не должно;
 * - снимка `state.parley` нет: перемирие выводится из **новых** событий и
 *   живёт внутри `mechanics.combat`, поэтому старый журнал воспроизводит его
 *   без бампа `GAME_STATE_PROJECTOR_VERSION` — восстанавливать в старых
 *   кампаниях попросту нечего.
 */

export const PARLEY_SCHEMA_VERSION = 1
export const PARLEY_POLICY_ID = 'skazanie:parley-v1'

/** Чем можно давить на переговорах. Список закрытый и серверный. */
export const PARLEY_SKILLS = Object.freeze(['persuasion', 'intimidation'])
export const PARLEY_ABILITY = 'cha'

/** Команды парлея. Обе доступны игроку: предложить и договориться. */
export const PARLEY_COMMAND_TYPES = Object.freeze(new Set(['ProposeParley', 'SettleParley']))

/**
 * Чем перемирие рвут. Список закрыт умышленно и держит только то, что за
 * столом однозначно читается как удар: атака, площадная атака и заклинание.
 * Перемещение, осмотр и разговор перемирия не нарушают — иначе «подойти ближе,
 * чтобы говорить» считалось бы вероломством.
 */
export const TRUCE_BREAKING_COMMAND_TYPES = Object.freeze(new Set([
  'MakeAttack', 'MakeAreaAttack', 'CastSpell', 'ApplyDamage',
]))

/**
 * Кто вообще способен вести переговоры. Список тот же по смыслу, что у плена:
 * договориться можно с тем, у кого есть речь и своя выгода. Скелет, студень и
 * волк в этот список не входят — и не потому, что их жалко, а потому, что
 * предлагать им нечего.
 */
export const NEGOTIABLE_CREATURE_TYPES = Object.freeze(new Set([
  'humanoid', 'giant', 'fiend', 'celestial', 'dragon',
]))

/**
 * Черты, которые движок уже трактует как «дерётся до конца»: кровавая ярость
 * усиливает раненого вместо того, чтобы сломить его, а неотступная охота гонит
 * существо за целью, что бы ни случилось. Носитель такой черты на парлей не
 * отвечает — это и есть фанатик в терминах брифа.
 */
export const ZEALOT_TRAIT_IDS = Object.freeze(new Set(['bloodied-frenzy', 'relentless-pursuit']))

/**
 * Почему разговора не вышло — и что при этом слышит стол. Таблица одна на обе
 * задачи намеренно: два списка причин разошлись бы при первой же правке, а
 * причина отказа и есть то, что игроку показывают. `roll_failed` здесь нет: у
 * неудачного броска реплика своя, детерминированная от боя (`parleyTaunt`).
 */
export const PARLEY_REFUSAL_LINES = Object.freeze({
  no_leader: 'Отвечать уже некому: на ногах никого не осталось.',
  mindless: 'Окрик уходит в пустоту: этим существам нечего сказать и нечего просить.',
  zealots: 'Ответом только рёв: эти дерутся до конца и слов не слышат.',
})

export const PARLEY_REFUSAL_REASONS = Object.freeze(Object.keys(PARLEY_REFUSAL_LINES))

/**
 * Исходы перемирия. `resume` — всегда доступный отказ от уговора; остальные
 * открываются положением стороны противника, а не желанием клиента.
 */
export const PARLEY_OUTCOMES = Object.freeze(['withdraw', 'tribute', 'surrender', 'resume'])

/**
 * Карточка условий, которую видит стол. Формулировки серверные: если бы их
 * сочинял клиент, «уйти с миром» и «сдаться» перестали бы отличаться механикой.
 */
export const PARLEY_TERMS = Object.freeze({
  withdraw: Object.freeze({
    id: 'withdraw',
    label: 'Разойтись миром',
    summary: 'Противник уходит со сцены и клянётся не возвращаться. Поле остаётся за отрядом.',
  }),
  tribute: Object.freeze({
    id: 'tribute',
    label: 'Уйти, оставив добычу',
    summary: 'Противник уходит и оставляет отряду всё взятое. Клятва не возвращаться — часть уговора.',
  }),
  surrender: Object.freeze({
    id: 'surrender',
    label: 'Сложить оружие',
    summary: 'Противник сдаётся отряду и переходит в плен, когда бой будет закрыт.',
  }),
  resume: Object.freeze({
    id: 'resume',
    label: 'Разойтись без уговора',
    summary: 'Переговоры кончились ничем: перемирие снимается, и бой продолжается с текущего хода.',
  }),
})

/** База СЛ: сторона в полной силе слушать не станет. */
export const PARLEY_BASE_DC = 20
/** Насколько сильно на СЛ влияют потерянные ОЗ и выбывшие бойцы. */
export const PARLEY_HEALTH_WEIGHT = 8
export const PARLEY_LOSS_WEIGHT = 6

/**
 * Порог «сломленности» (сумма двух давлений выше), с которого противник готов
 * на соответствующий уговор. `withdraw` порога не имеет: сторона, которая
 * согласилась говорить, всегда может просто уйти.
 */
export const PARLEY_OUTCOME_THRESHOLDS = Object.freeze({ withdraw: 0, tribute: 6, surrender: 10 })

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const comparable = (value) => text(value, 180).toLocaleLowerCase('ru')

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

function pick(list, seed, salt = '') {
  const values = Array.isArray(list) ? list : []
  if (!values.length) return null
  return values[Number.parseInt(digest(seed, salt).slice(0, 8), 16) % values.length]
}

// ---------------------------------------------------------------------------
// Сторона противника
// ---------------------------------------------------------------------------

function conditionIdSet(state, actorId) {
  return new Set((state?.mechanics?.conditions?.[String(actorId)] ?? [])
    .map((condition) => String(condition?.id ?? condition)))
}

function isStanding(state, enemy) {
  if (!enemy?.id) return false
  if (enemy.alive === false || Math.max(0, integer(enemy.hp, 0)) <= 0) return false
  const conditions = conditionIdSet(state, enemy.id)
  return !conditions.has('fled') && !conditions.has('surrendered') && !conditions.has('unconscious')
}

function creatureTypeOf(enemy = {}) {
  return comparable(enemy.creature_type ?? enemy.creatureType ?? enemy.monster_type ?? enemy.kind)
}

function traitIds(enemy = {}) {
  return new Set((Array.isArray(enemy?.traits) ? enemy.traits : []).map((trait) => String(trait?.id ?? trait)))
}

/** Уцелевшие противники — те, с кем ещё можно говорить и кто ещё дерётся. */
export function standingEnemies(state = {}) {
  return (Array.isArray(state?.enemies) ? state.enemies : [])
    .filter((enemy) => isStanding(state, enemy))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

/**
 * Кто отвечает за сторону. Самый крепкий из уцелевших: за столом окрик слышат
 * все, а отвечает тот, кого слушаются. Ничьи разводятся идентификатором, чтобы
 * replay давал того же собеседника.
 */
export function parleyLeaderFor(state = {}) {
  const standing = standingEnemies(state)
  if (!standing.length) return null
  return standing.reduce((best, enemy) => {
    const bestScore = Math.max(0, integer(best?.maxHp ?? best?.max_hp, 0))
    const score = Math.max(0, integer(enemy.maxHp ?? enemy.max_hp, 0))
    if (score > bestScore) return enemy
    if (score < bestScore) return best
    return String(enemy.id) < String(best.id) ? enemy : best
  }, standing[0])
}

/**
 * Мораль стороны противника — тот же вход, что у существующего движка морали
 * (`npc-controller.mjs`): доля оставшихся ОЗ и черты стат-блока. Разница в
 * том, что мораль там меряется у одного существа в момент его перелома, а
 * здесь — у стороны целиком и по требованию отряда.
 *
 * Чистая функция: одинаковое состояние даёт одинаковую СЛ и одинаковый список
 * исходов, поэтому replay воспроизводит переговоры без сюрпризов.
 */
export function parleyMoraleFor(state = {}) {
  const enemies = Array.isArray(state?.enemies) ? state.enemies : []
  const standing = standingEnemies(state)
  const leader = parleyLeaderFor(state)
  const total = enemies.filter((enemy) => enemy?.id).length
  const fallenRatio = total > 0 ? clamp((total - standing.length) / total, 0, 1) : 0
  const hpSum = standing.reduce((sum, enemy) => sum + Math.max(0, integer(enemy.hp, 0)), 0)
  const maxHpSum = standing.reduce((sum, enemy) => sum + Math.max(1, integer(enemy.maxHp ?? enemy.max_hp, 1)), 0)
  const healthRatio = maxHpSum > 0 ? clamp(hpSum / maxHpSum, 0, 1) : 0
  const healthPressure = Math.round((1 - healthRatio) * PARLEY_HEALTH_WEIGHT)
  const lossPressure = Math.round(fallenRatio * PARLEY_LOSS_WEIGHT)
  const pressure = healthPressure + lossPressure
  const zealots = standing.filter((enemy) => [...traitIds(enemy)].some((id) => ZEALOT_TRAIT_IDS.has(id)))
  const speakers = standing.filter((enemy) => NEGOTIABLE_CREATURE_TYPES.has(creatureTypeOf(enemy)))
  const refusal = !leader
    ? 'no_leader'
    // Фанатизм проверяется раньше речи намеренно: берсерк говорить умеет, но
    // не станет, и честный отказ называет именно эту причину.
    : zealots.length
      ? 'zealots'
      : !speakers.length || !NEGOTIABLE_CREATURE_TYPES.has(creatureTypeOf(leader))
        ? 'mindless'
        : null
  const difficulty = clamp(PARLEY_BASE_DC - pressure, 5, 30)
  const outcomes = refusal ? [] : ['resume', ...PARLEY_OUTCOMES.filter((outcome) => (
    outcome !== 'resume' && pressure >= (PARLEY_OUTCOME_THRESHOLDS[outcome] ?? 99)
  ))]
  return {
    leader_id: leader ? String(leader.id) : '',
    leader_name: text(leader?.name ?? leader?.character, 160),
    standing_count: standing.length,
    fallen_count: Math.max(0, total - standing.length),
    health_ratio: Number(healthRatio.toFixed(3)),
    health_pressure: healthPressure,
    loss_pressure: lossPressure,
    pressure,
    difficulty,
    refusal_reason: refusal,
    refuses: Boolean(refusal),
    outcomes: outcomes.sort(),
    policy_id: PARLEY_POLICY_ID,
  }
}

/**
 * Откуп. Сумма выводится из XP уцелевших — числа, которое уже лежит в
 * провенансе стат-блока, — а не из новой таблицы цен: за ватагу головорезов
 * отдают больше, чем за троих оборванцев.
 */
export function parleyTributeCp(state = {}) {
  const experience = standingEnemies(state)
    .reduce((sum, enemy) => sum + Math.max(0, integer(enemy?.provenance?.xp, 0)), 0)
  return clamp(Math.round(experience / 4 / 10) * 10, 20, 5_000)
}

// ---------------------------------------------------------------------------
// Состояние перемирия
// ---------------------------------------------------------------------------

export function normalizeTruce(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const leaderId = text(value.leader_id, 120)
  if (!leaderId) return null
  const outcomes = [...new Set((Array.isArray(value.outcomes) ? value.outcomes : [])
    .map((entry) => text(entry, 40)).filter((entry) => PARLEY_OUTCOMES.includes(entry)))].sort()
  return {
    schema_version: PARLEY_SCHEMA_VERSION,
    policy_id: PARLEY_POLICY_ID,
    leader_id: leaderId,
    leader_name: text(value.leader_name, 160),
    hero_id: text(value.hero_id, 120),
    hero_name: text(value.hero_name, 160),
    skill: PARLEY_SKILLS.includes(String(value.skill)) ? String(value.skill) : 'persuasion',
    difficulty: clamp(integer(value.difficulty, PARLEY_BASE_DC), 5, 30),
    total: integer(value.total, 0),
    round: Math.max(0, integer(value.round, 0)),
    established_at_minutes: Math.max(0, integer(value.established_at_minutes, 0)),
    outcomes: outcomes.length ? outcomes : ['resume'],
    tribute_cp: Math.max(0, integer(value.tribute_cp, 0)),
  }
}

/** Действующее перемирие текущего боя либо `null`. */
export function truceFor(state = {}) {
  const combat = state?.mechanics?.combat
  if (!combat?.active) return null
  return normalizeTruce(combat.truce)
}

/** Держится ли перемирие прямо сейчас — единственный предикат на весь проект. */
export function truceHolds(state = {}) {
  return truceFor(state) !== null
}

/** Сколько раз отряд уже пробовал договориться в этом бою. */
export function parleyAttempts(state = {}) {
  return Math.max(0, integer(state?.mechanics?.combat?.parley_attempts, 0))
}

/** Условия перемирия карточкой: подписи и пояснения берутся из каталога. */
export function parleyTermsFor(truce = {}) {
  return (Array.isArray(truce?.outcomes) ? truce.outcomes : [])
    .map((outcome) => PARLEY_TERMS[outcome])
    .filter(Boolean)
    .map((term) => ({ ...term }))
}

// ---------------------------------------------------------------------------
// Свободная фраза
// ---------------------------------------------------------------------------

/**
 * Закрытый серверный список фраз, которыми парлей объявляют голосом. Это
 * маршрут, а не второй движок: распознанная фраза превращается в ту же команду
 * `ProposeParley`, которой пользуется кнопка хотбара, и дальше всё решают
 * правила.
 *
 * Список детерминированный намеренно: без ключа модели игра обязана оставаться
 * играбельной, а «кричу им: остановитесь, поговорим!» — не тот случай, где
 * нужна творческая интерпретация.
 *
 * Каждая альтернатива якорится по началу слова (`(?<!\p{L})`): без якоря
 * «перемирие» находилось бы внутри чужого слова, а распознавание стоит **до**
 * разбора намерения и тратит действие героя.
 */
const PARLEY_PHRASE = /(?<!\p{L})(?:парл[еи]й|переговор|перемири|поговорим|давай(?:те)?\s+погово|погово\p{L}*\s+(?:миром|по-хорошему)|сложите\s+оружие|опустите\s+оружие|брос(?:ай|ьте)\s+оружие|прекрат\p{L}*\s+(?:бой|драк)|хватит\s+(?:драться|биться)|не\s+хотим\s+(?:драться|биться)|предлага\p{L}*\s+(?:мир|сдаться)|сдавайтесь)/iu

/**
 * Встречные признаки: слово о переговорах в фразе есть, а предложения
 * переговоров — нет. Цена ошибки здесь несимметрична, и правило подогнано
 * именно под неё: непонятый окрик уходит обычным свободным действием и стоит
 * игроку одной переформулировки, а понятый неверно **сжигает действие** и
 * заводит в бою перемирие, которого никто не просил. Поэтому при любом
 * встречном признаке фраза парлеем не считается.
 *
 * Позиции списка закрыты и объяснимы:
 * - `attack` — удар уже наносится: первое лицо настоящего времени называет
 *   исполняемое действие, а не угрозу на переговорах. Будущее («убью») сюда
 *   не входит: «прекрати бой, или я тебя убью» — это нажим, а не удар;
 * - `negation` — переговоры названы, чтобы их отвергнуть;
 * - `own_surrender` — сдаётся сам герой, и предлагать врагу тут нечего;
 * - `postponed` — разговор отложен на «после боя»;
 * - `recollection` — о переговорах вспоминают, а не объявляют их.
 */
const PARLEY_COUNTER_PHRASES = Object.freeze({
  attack: /(?<!\p{L})(?:бью|бь[её]м|атаку(?:ю|ем)|напада(?:ю|ем)|руб(?:лю|им)|реж(?:у|ем)|кол(?:ю|ем)|стреля(?:ю|ем)|мечу|кида(?:ю|ем)|швыря(?:ю|ем)|добива(?:ю|ем)|наношу\s+удар|замахива(?:юсь|емся))(?!\p{L})/iu,
  negation: /(?<!\p{L})(?:никак(?:их|ого)\s+(?:переговор|перемири|уговор|разговор)|не\s+пахнет|не\s+буд(?:у|ем|ет)\s+(?:говорить|договар|переговар)|какие\s+(?:уж\s+)?(?:тут\s+)?переговор|не\s+о\s+ч[её]м\s+говорить)/iu,
  own_surrender: /(?<!\p{L})(?:сдаюсь|сда[её]мся)(?!\p{L})/iu,
  postponed: /(?<!\p{L})(?:после\s+бо[яю]|после\s+драки|позже|потом|не\s+сейчас|когда\s+(?:вс[её]\s+)?(?:закончим|кончится|закончится))(?!\p{L})/iu,
  recollection: /(?<!\p{L})(?:помню|вспомн\p{L}*|припомин\p{L}*|говорил\p{L}*\s+(?:про|о(?!\p{L}))|рассказыва\p{L}*|слыша\p{L}*\s+(?:про|о(?!\p{L})))/iu,
})

export const PARLEY_COUNTER_REASONS = Object.freeze(Object.keys(PARLEY_COUNTER_PHRASES))

/**
 * Почему распознанное слово о переговорах окриком не считается, либо `null`.
 * Отдельная функция, а не флаг внутри `mentionsParley`: причина нужна тестам и
 * диагностике, а второго списка встречных признаков в проекте быть не должно.
 */
export function parleyCounterReasonFor(value = '') {
  const phrase = text(value, 1_000)
  return PARLEY_COUNTER_REASONS.find((reason) => PARLEY_COUNTER_PHRASES[reason].test(phrase)) ?? null
}

export function mentionsParley(value = '') {
  const phrase = text(value, 1_000)
  return PARLEY_PHRASE.test(phrase) && parleyCounterReasonFor(phrase) === null
}

/**
 * Чем давят: нажим или уговор. Список нажима держится рядом с распознаванием
 * фразы намеренно — раньше он лежал в оркестраторе и расходился с ним по
 * смыслу: «прекрати бой, или я тебя убью» оркестратор читал как вежливую
 * просьбу и подавал Убеждением.
 */
const PARLEY_PRESSING_PHRASE = /(?<!\p{L})(?:сдавайтесь|сложите\s+оружие|опустите\s+оружие|брос(?:ай|ьте)\s+оружие|предлага\p{L}*\s+сдаться|или\s+(?:я|мы)(?!\p{L})|иначе(?!\p{L})|убь\p{L}*|прикончу|заруб(?:лю|им)|перебь\p{L}*|пожале(?:ешь|ете)|последнее\s+предупреждение)/iu

export function parleySkillFor(value = '') {
  return PARLEY_PRESSING_PHRASE.test(text(value, 1_000)) ? 'intimidation' : 'persuasion'
}

// ---------------------------------------------------------------------------
// Насмешки и реплики
// ---------------------------------------------------------------------------

const PARLEY_TAUNTS = Object.freeze([
  'Смех в ответ: «Поздно торговаться, пришлые».',
  '«Говорить будешь с землёй», — и сталь снова идёт вперёд.',
  '«Мы не для разговоров сюда шли».',
  'Плевок под ноги вместо ответа.',
  '«Слова кончились там, где вы взялись за оружие».',
  '«Проси у своих богов, а не у нас».',
])

/** Насмешка после провала: одинаковая при каждом replay того же боя. */
export function parleyTaunt(state = {}, { leaderId = '', round = 0, attempt = 1 } = {}) {
  const seed = digest(text(state?.sessionCode, 60), text(leaderId, 120), String(round), String(attempt))
  return pick(PARLEY_TAUNTS, seed, 'taunt') ?? PARLEY_TAUNTS[0]
}

export function parleyRefusalLine(reason = '') {
  return PARLEY_REFUSAL_LINES[String(reason)] ?? PARLEY_REFUSAL_LINES.mindless
}

// ---------------------------------------------------------------------------
// Редьюсер боевого состояния
// ---------------------------------------------------------------------------

/**
 * Что событие парлея меняет в `mechanics.combat`. Возвращается **патч**, а не
 * целый combat: очередь, экономика хода и окно реакции этому модулю не
 * принадлежат, и переписывать их отсюда нельзя.
 *
 * @returns {object|null} патч для `mechanics.combat` либо `null`
 */
export function parleyCombatPatch(combat = {}, event = {}) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  if (type === 'ParleyProposed') {
    return { parley_attempts: Math.max(0, integer(combat?.parley_attempts, 0)) + 1 }
  }
  if (type === 'TruceEstablished') {
    const truce = normalizeTruce(payload.truce)
    return truce ? { truce } : null
  }
  // Разорванное и исполненное перемирие не остаётся «сломанной» записью в
  // состоянии: то, что случилось, уже лежит в журнале и в летописи поступков.
  // Держать после этого объект в `combat` значило бы завести второй источник
  // истины о том, идёт ли бой.
  if (type === 'TruceBroken' || type === 'ParleySettled') return { truce: null }
  return null
}
