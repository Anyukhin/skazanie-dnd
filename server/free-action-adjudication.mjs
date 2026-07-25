import { createHash } from 'node:crypto'

import { DIFFICULTY_CLASSES } from './adjudicator.mjs'

/**
 * Серверное судейство свободного действия — то, что живой ведущий решает в уме.
 *
 * Разделение обязанностей жёсткое: модель может предложить только смысл действия и
 * категорию из перечисления, а режим разрешения, число СЛ и последствие выбирает
 * сервер. Модуль детерминированный и без вызовов LLM, как `campaign-loop-policy.mjs`.
 */

const clean = (value, maximum = 300) => String(value ?? '')
  .normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)

export const PLAUSIBILITY_LEVELS = Object.freeze(['trivial', 'plausible', 'strenuous', 'impossible_without_means'])
export const RISK_LEVELS = Object.freeze(['none', 'minor', 'serious', 'deadly'])
export const RESOLUTION_MODES = Object.freeze(['auto_success', 'check', 'counter_offer'])

const inEnum = (values, value, fallback) => (values.includes(String(value)) ? String(value) : fallback)

/**
 * Шаг 3 брифа: ведущий не требует броска, когда на кону ничего нет. Незапертую дверь
 * открывают без кубика — это правило, а не срезание угла.
 */
export function resolutionModeFor({ plausibility, risk } = {}) {
  const level = inEnum(PLAUSIBILITY_LEVELS, plausibility, 'plausible')
  const stake = inEnum(RISK_LEVELS, risk, 'minor')
  if (level === 'impossible_without_means') return { mode: 'counter_offer', difficulty_category: null, difficulty: null }
  if (stake === 'none' && (level === 'trivial' || level === 'plausible')) {
    return { mode: 'auto_success', difficulty_category: null, difficulty: null }
  }
  const category = level === 'trivial'
    ? 'easy'
    : level === 'strenuous' || stake === 'deadly'
      ? 'hard'
      : 'medium'
  return { mode: 'check', difficulty_category: category, difficulty: DIFFICULTY_CLASSES[category] }
}

/**
 * Шаг 1 брифа, детерминированная половина. Модель, когда она доступна, предлагает те же
 * поля из тех же перечислений; здесь они выводятся из текста без вызова LLM, чтобы игра
 * оставалась играбельной без ключа.
 *
 * Подход определяет характеристику: «запугиваю силой» — это Запугивание от Силы, поэтому
 * характеристика и навык выбираются независимо друг от друга.
 */
const APPROACH_PATTERNS = Object.freeze([
  { test: /(подпира|баррикад|завал|подпер|держ\w+\s+двер)/iu, ability: 'str', skill: 'athletics', plausibility: 'plausible', risk: 'minor', obstacle: 'дверь' },
  { test: /(взлам|выбива|выломать|ломаю)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'преграда' },
  { test: /(поджиг|зажиг|подпал|факел\w*\s+к)/iu, ability: 'dex', skill: 'sleight-of-hand', plausibility: 'plausible', risk: 'serious', obstacle: 'огонь' },
  { test: /(крад|тих\w+|незамет|прячусь|скрыва)/iu, ability: 'dex', skill: 'stealth', plausibility: 'plausible', risk: 'minor', obstacle: 'наблюдатели' },
  { test: /(запуг|угрож|пригрож)/iu, ability: 'cha', skill: 'intimidation', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(убежда|уговар|догова|прош\w+\s+помощ)/iu, ability: 'cha', skill: 'persuasion', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(обман|вру|соврать|притвор)/iu, ability: 'cha', skill: 'deception', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(крич|зову|окликa|подзыва)/iu, ability: 'cha', skill: 'persuasion', plausibility: 'plausible', risk: 'minor', obstacle: 'окружающие' },
  { test: /(осматр|разгляд|изуча|ищу\s+след|обыск)/iu, ability: 'wis', skill: 'perception', plausibility: 'trivial', risk: 'none', obstacle: 'обстановка' },
  { test: /(вспомина|припомин|знаю\s+ли|что\s+известно)/iu, ability: 'int', skill: 'history', plausibility: 'trivial', risk: 'none', obstacle: 'память' },
  { test: /(залез|взбира|караб|подтягива)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'высота' },
  { test: /(перепрыг|прыга|перескоч)/iu, ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous', risk: 'serious', obstacle: 'разрыв' },
])

export function interpretFreeAction(text = '') {
  const value = clean(text, 1_000)
  const match = APPROACH_PATTERNS.find((pattern) => pattern.test.test(value)) ?? null
  return {
    goal_summary: value.slice(0, 200),
    approach_summary: value.slice(0, 200),
    ability: match?.ability ?? 'wis',
    skill: match?.skill ?? 'perception',
    plausibility: match?.plausibility ?? 'plausible',
    risk: match?.risk ?? 'minor',
    obstacle: match?.obstacle ?? clean(value, 120),
    required_means: [],
    source: match ? 'deterministic-pattern' : 'deterministic-default',
  }
}

function actorMeans(state = {}, actorId = '') {
  const actor = (state.players ?? []).find((entry) => String(entry?.id) === String(actorId)) ?? null
  const inventory = Array.isArray(actor?.inventory) ? actor.inventory : []
  const ids = new Set()
  for (const item of inventory) {
    for (const value of [item?.id, item?.catalog_id, item?.name]) if (value) ids.add(clean(value, 160).toLocaleLowerCase('ru'))
  }
  for (const key of ['knownSpellIds', 'preparedSpellIds', 'selectedFeatureIds', 'classSkillProficiencies']) {
    for (const value of actor?.[key] ?? []) if (value) ids.add(clean(value, 160).toLocaleLowerCase('ru'))
  }
  return ids
}

/**
 * Шаг 2 брифа: сверка заявленных средств с миром. Это единственное честное место
 * сказать «такого у героя нет» — до броска и до расхода хода.
 */
export function verifyMeans(state = {}, actorId = '', requiredMeans = []) {
  const available = actorMeans(state, actorId)
  const required = [...new Set((Array.isArray(requiredMeans) ? requiredMeans : [])
    .map((value) => clean(value, 160)).filter(Boolean))]
  const missing = required.filter((value) => !available.has(value.toLocaleLowerCase('ru')))
  return { satisfied: missing.length === 0, required, missing }
}

/**
 * Шаг 5 брифа: провал не означает «ничего не произошло». Каталог серверный и
 * ограниченный — модель выбирает уровень риска, но не сочиняет последствие.
 *
 * Автоматический урон за провал импровизации намеренно не реализован: он требует
 * настоящей модели опасностей, иначе наказание окажется произвольным. Уровень `deadly`
 * поэтому даёт самое тяжёлое из неуронных последствий и отмечается отдельно.
 */
const FAIL_FORWARD = Object.freeze({
  none: Object.freeze({ minutes: 5, advances_quest_clock: false, summary: 'Попытка отняла немного времени и ничего не изменила в обстановке.' }),
  minor: Object.freeze({ minutes: 10, advances_quest_clock: false, summary: 'Попытка сорвалась и наделала шума: место перестало быть спокойным.' }),
  serious: Object.freeze({ minutes: 20, advances_quest_clock: true, summary: 'Неудача дорого обошлась: положение осложнилось, и события пошли своим ходом.' }),
  deadly: Object.freeze({ minutes: 30, advances_quest_clock: true, escalates: true, summary: 'Риск оправдался худшим образом: опасность стала явной и близкой.' }),
})

export function failForwardFor(risk = 'minor') {
  const stake = inEnum(RISK_LEVELS, risk, 'minor')
  return { risk: stake, ...FAIL_FORWARD[stake] }
}

/**
 * Шаг 4 брифа: ставки объявляются до броска. Живой ведущий говорит «Атлетика, СЛ 15;
 * сорвёшься — потеряешь время и наделаешь шума» прежде, чем кубик брошен.
 */
export function stakesFor({ ability = '', skill = '', resolution = {}, risk = 'minor' } = {}) {
  if (resolution.mode !== 'check') return null
  const consequence = failForwardFor(risk)
  return {
    ability: clean(ability, 20),
    skill: clean(skill, 60),
    difficulty: resolution.difficulty,
    difficulty_category: resolution.difficulty_category,
    on_failure: consequence.summary,
    policy: 'free-action-stakes-v1',
  }
}

/**
 * Шаг 6 брифа: живой ведущий не разрешает перекатывать ту же попытку, пока
 * обстоятельства не изменились. Отпечаток берётся от героя, подхода и препятствия.
 */
export function attemptFingerprint({ actorId = '', approach = '', obstacle = '' } = {}) {
  return digest({
    actor: clean(actorId, 120),
    approach: clean(approach, 300).toLocaleLowerCase('ru'),
    obstacle: clean(obstacle, 300).toLocaleLowerCase('ru'),
  })
}

/** Отпечаток обстановки: пока он не сменился, повтор того же подхода бессмыслен. */
export function situationFingerprint(state = {}) {
  return digest({
    location: clean(state.scene?.location, 180),
    objective: clean(state.scene?.objective, 300),
    revealed: (state.scene?.cells ?? []).filter((cell) => cell.revealed === true).length,
    combat: Boolean(state.mechanics?.combat?.active),
    round: Number(state.mechanics?.combat?.round) || 0,
    elapsed: Number(state.mechanics?.world_time?.elapsed_minutes) || 0,
  })
}

/**
 * Ищет уже проваленную попытку с тем же подходом в неизменившейся обстановке.
 * Возвращает найденную запись или null.
 */
export function previousFailedAttempt(state = {}, fingerprint = '') {
  const situation = situationFingerprint(state)
  return (state.rulings ?? []).find((ruling) => {
    const provenance = ruling?.provenance ?? {}
    return provenance.attempt_fingerprint === fingerprint
      && provenance.situation_fingerprint === situation
      && ruling.outcome === 'failure'
  }) ?? null
}
