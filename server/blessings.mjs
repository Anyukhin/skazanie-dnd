import { createHash } from 'node:crypto'

import { normalizeNpcWorldState, presentSceneNpcs, sceneLocationId } from './npc-positioning.mjs'
import { factionIdsForNpc } from './reputation-policy.mjs'

/**
 * Молитвы и благословения.
 *
 * Каталог ситуаций стола (`docs/dnd-table-situations.md`, F2) держал эту строку
 * в «частично», и формулировал дыру точно: алтарь на карте был, а услышанной
 * молитвы — то есть ответа мира на обращение — не было. Пропс-святыня умел
 * ровно две вещи: его осматривали проверкой Религии и один раз «использовали»
 * ради временного хита. Ни молитвы, ни жреца, ни благословения в проекте не
 * существовало.
 *
 * Модуль детерминированный и без обращений к модели — как `tavern-life.mjs`,
 * `captives.mjs` и `law-and-order.mjs`. Устроен он так:
 *
 * 1. **Благословение — существующее состояние, а не своё правило.**
 *    `minor-blessing` живёт в той же таблице `CONDITION_EFFECTS`, что и
 *    «Зачарование оружия», и двигает то же число: плоский `+1` к броску атаки.
 *    Своей арифметики у благословения нет ни одной строки, поэтому и разойтись
 *    ей не с чем.
 *
 *    Выбор эффекта — честный минимум, а не первое попавшееся. Преимущество на
 *    спасбросок в этом движке дороже: спасброски идут через единую воронку
 *    (`rollSavingThrowD20`), у которой нет своего пакета событий, — снять
 *    состояние после первого же спасброска оттуда нечем, и «преимущество на
 *    первый спасбросок» неминуемо стало бы «преимуществом на все спасброски до
 *    отдыха». Это уже не малое благословение, а заклинание третьего круга
 *    задаром. Плоский `+1` до первой атаки снимается ровно там, где применён, и
 *    обещает игроку ровно то, что делает.
 *
 * 2. **Оно расходуется первой атакой и живёт до продолжительного отдыха.**
 *    Два предела, а не один: без расхода герой ходил бы с постоянным `+1`
 *    сутки напролёт, без срока — благословение копилось бы на полке. Срок
 *    держит существующий редьюсер отдыха (`until-long-rest`), расход —
 *    `ConditionRemoved` в том же пакете, где посчитана атака.
 *
 * 3. **Раз в сутки на героя, и сутки считаются по попытке, а не по успеху.**
 *    Иначе неудачную молитву повторяли бы до двадцатки, и проверка Религии
 *    превратилась бы в формальность: у алтаря никто никуда не спешит. Поэтому
 *    день закрывает **любое** обращение — и молитва, и жрец, — а выбор между
 *    ними герой делает один раз.
 *
 * 4. **Провал ничего не отнимает.** Молитва, оставшаяся без ответа, — это
 *    молчание, а не наказание: карать за обращение к богам значит отучить от
 *    него стол. Натуральная единица отвечает знамением — строкой, и только
 *    строкой: механики за ней нет, а тревога за столом появляется.
 *
 * 5. **Жрец благословляет без броска, за пожертвование.** Это не «то же самое
 *    дешевле»: молитва бесплатна и может не сбыться, храм берёт деньги и
 *    отвечает наверняка. Пожертвование при этом не пропадает в никуда — оно
 *    поднимает репутацию фракций самого жреца тем же событием
 *    (`FactionReputationAdjusted`), которым её двигают слухи и поступки. Своей
 *    репутации у храма модуль не заводит.
 *
 * 6. **Благословение остаётся фактом мира.** `WorldFactRecorded` пишется на
 *    каждое полученное благословение, поэтому рассказчик и NPC могут о нём
 *    вспомнить — как о любом другом подтверждённом событии.
 *
 * Осознанные границы (решено, а не забыто):
 * - **своего реестра бросков здесь нет**: ручной кубик молитвы идёт тем же
 *   двухфазным путём (`server/roll-registry.mjs`), что у парлея, костей и
 *   уговора зверя;
 * - **благословение не складывается само с собой**: второе подряд не выдаётся,
 *   потому что второго обращения в сутки не бывает, — но и на случай правки
 *   движок не вешает состояние, которое на герое уже есть;
 * - **жрец опознаётся ролью, а не тегом фракции**: тег `faction:` есть далеко
 *   не у каждого NPC, а роль в профиле есть всегда, и именно она видна игроку
 *   на токене.
 */

/**
 * Версия среза благословений. Двигать её обязательно при любой правке формы
 * записи: быстрый путь в `applyBlessingEvent` берёт срез со «своей» версией как
 * есть, без повторной нормализации.
 */
export const BLESSINGS_SCHEMA_VERSION = 1
export const BLESSINGS_POLICY_ID = 'skazanie:blessings-v1'

/** Команды благословений. Одна: молитва идёт через `OperateSceneObject`. */
export const BLESSING_COMMAND_TYPES = Object.freeze(new Set(['ReceiveNpcBlessing']))

/**
 * Состояние малого благословения. Имя отдельное от `bless-d4`, и это не
 * придирка: `bless-d4` — заклинание с концентрацией и костью на каждый бросок,
 * а это — плоская единица до первой атаки. Одно имя на два разных правила
 * однажды сложилось бы в одном броске дважды.
 */
export const BLESSING_CONDITION = 'minor-blessing'

/**
 * Срок. Любая непустая и не «вечная» длительность сметается продолжительным
 * отдыхом (`RestCompleted`, `server/rules-engine.mjs`), а раундами не тикает:
 * счётчик знает только `until-next-turn` и `rounds:N`. Это ровно «до отдыха».
 */
export const BLESSING_DURATION = 'until-long-rest'

/** Насколько точнее бьёт благословлённый. Один — и это весь эффект. */
export const BLESSING_ATTACK_BONUS = 1

/** Сутки кампании: столько ждёт герой между обращениями. */
export const BLESSING_COOLDOWN_MINUTES = 1_440

/** Чем меряется молитва. Навык серверный и закрытый — клиенту его не подменить. */
export const PRAYER_SKILL = 'religion'
export const PRAYER_ABILITY = 'int'

/**
 * СЛ молитвы. Двенадцать — «умеренно» по редакции: герой без владения Религией
 * проходит её примерно в половине случаев, жрец — почти всегда. Число
 * серверное и от пропса не зависит: у святыни нет замка, который можно было бы
 * сделать сложнее.
 */
export const PRAYER_DC = 12

/** Сколько минут кампании отнимает молитва и приём у жреца. */
export const PRAYER_MINUTES = 15
export const NPC_BLESSING_MINUTES = 15

/**
 * Пожертвование за благословение жреца. Золотой — цена, которую отряд первого
 * уровня чувствует, но платит; ниже неё храм был бы дешевле кружки эля.
 */
export const BLESSING_DONATION_CP = 100

/** Насколько теплеет фракция жреца после пожертвования. */
export const BLESSING_REPUTATION_DELTA = 2

/**
 * Кого храм зовёт своим служителем. Список закрытый и серверный: роль NPC
 * сочиняет модель, но благословлять может только тот, чья роль названа здесь.
 *
 * Основы закреплены окончаниями там, где голая основа ловит чужое слово:
 * `монах` без границы сидел бы в «мономахе», `инок` — в «поединок» и «пёсинок».
 * Кириллица для `\b` буквой не считается, поэтому границы просят
 * ретроспективной проверки, а не `\b`.
 */
const PRIEST_PATTERN = /жре[цч]|жриц|свяще|иерей|настоятел|аббат|клирик|(?<![а-яё])монах|(?<![а-яё])инок(?![а-яё])|проповедн|priest|cleric|abbot|(?<![a-zа-яё])monk(?![a-zа-яё])|acolyte|послушни/iu

/**
 * Знамения на натуральной единице. Таблица закрытая: строку видит игрок, и
 * сочинять её на ходу нельзя — иначе одна и та же неудача при replay
 * рассказывалась бы по-разному.
 *
 * Механики за знамением нет ни на грош, и это осознанно: тревога — это то, что
 * стол додумает сам, а движок, который на неё ещё и штрафует, отучает молиться.
 */
const OMENS = Object.freeze([
  'Пламя над алтарём приседает и гаснет само собой. Никто его не тушил.',
  'Слова молитвы возвращаются глухим эхом — будто их не приняли, а вернули.',
  'По камню святыни проступает влага и стекает вниз тремя дорожками.',
  'На миг делается очень тихо: не слышно ни ветра, ни собственного дыхания.',
  'Тень от изваяния ложится не в ту сторону и держится так, пока герой не отступит.',
])

/** Что молитва оставляет герою вместо благословения. Ни одного отнятого числа. */
export const PRAYER_OUTCOMES = Object.freeze(['blessed', 'silence', 'omen'])

/** Откуда пришло благословение. Два источника, и оба закрывают одни сутки. */
export const BLESSING_SOURCES = Object.freeze(['shrine', 'priest'])

/**
 * Сколько героев помнит реестр. Предел обязателен — это состояние кампании, и
 * расти без края ему нельзя. Записи заводятся только на героев отряда
 * (`playerActor` в валидации), поэтому добраться до предела в игре нечем, но
 * защита от роста дырой быть не должна и в недостижимой ветке: вытесняется
 * самая старая запись, и вытесняется она **по минуте обращения**, а не по
 * порядку появления — иначе replay разошёлся бы со снимком.
 */
const MAX_BLESSED_HEROES = 12

const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback)

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

function safeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const atMinutes = Math.max(0, integer(value.at_minutes, 0))
  const source = BLESSING_SOURCES.includes(text(value.source, 20)) ? text(value.source, 20) : 'shrine'
  return {
    // Минута последнего обращения — она же и есть суточный слот. Отдельного
    // поля «когда снова можно» здесь нет намеренно: оно равнялось бы этой
    // минуте плюс константа всегда, и два числа с одним смыслом однажды
    // разошлись бы.
    at_minutes: atMinutes,
    source,
    // Чем кончилось обращение. Благословение и молчание закрывают сутки
    // одинаково, но записаны по-разному: карточка обязана сказать игроку, было
    // сегодня благословение или нет.
    granted: value.granted === true,
    place_name: text(value.place_name, 180),
    npc_id: text(value.npc_id, 120),
    npc_name: text(value.npc_name, 160),
  }
}

export function normalizeBlessingState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const kept = new Map()
  for (const [heroId, record] of Object.entries(source.heroes ?? {})) {
    const id = text(heroId, 120)
    const safe = safeRecord(record)
    if (id && safe) kept.set(id, safe)
  }
  const evicted = new Set(
    kept.size <= MAX_BLESSED_HEROES ? [] : [...kept.entries()]
      // Ключ сортировки двойной: минута обращения, а при совпадении — порядок в
      // карте. Двух одинаковых ответов на «кого забыть» быть не должно.
      .map(([id, record], index) => ({ id, at: record.at_minutes, index }))
      .sort((left, right) => left.at - right.at || left.index - right.index)
      .slice(0, kept.size - MAX_BLESSED_HEROES)
      .map((entry) => entry.id),
  )
  const heroes = {}
  for (const [id, record] of kept) if (!evicted.has(id)) heroes[id] = record
  return { schema_version: BLESSINGS_SCHEMA_VERSION, heroes }
}

/** Последнее обращение этого героя к богам, либо `null`. */
export function blessingRecordFor(state = {}, heroId = '') {
  return normalizeBlessingState(state?.blessings).heroes[text(heroId, 120)] ?? null
}

/** Несёт ли герой благословение прямо сейчас. Правда одна — само состояние. */
export function heroIsBlessed(state = {}, heroId = '') {
  const conditions = state?.mechanics?.conditions?.[text(heroId, 120)]
  return (Array.isArray(conditions) ? conditions : [])
    .some((condition) => String(condition?.id ?? condition) === BLESSING_CONDITION)
}

/**
 * Можно ли герою обращаться к богам сейчас и когда будет можно.
 *
 * Одна функция на все три вопроса — валидацию, карточку и подсказку: второго
 * ответа на «прошли ли сутки» в проекте быть не должно.
 */
export function blessingAvailabilityFor(state = {}, heroId = '', atMinutes = 0) {
  const record = blessingRecordFor(state, heroId)
  const now = Math.max(0, integer(atMinutes, 0))
  if (!record) return { available: true, next_at_minutes: 0, waits_minutes: 0 }
  const next = record.at_minutes + BLESSING_COOLDOWN_MINUTES
  return {
    available: now >= next,
    next_at_minutes: next,
    waits_minutes: Math.max(0, next - now),
  }
}

// ---------------------------------------------------------------------------
// Жрецы
// ---------------------------------------------------------------------------

/** Служитель ли это. Читается роль профиля — то же слово, что видит игрок. */
export function isPriestProfile(npc = {}) {
  return PRIEST_PATTERN.test(`${text(npc?.role, 160)} ${(Array.isArray(npc?.tags) ? npc.tags : []).map((tag) => text(tag, 60)).join(' ')}`)
}

/**
 * У кого в этой сцене можно попросить благословение. Живые NPC текущей сцены,
 * которых видит отряд, и ни одного враждебного: тот, кто уже взялся за нож,
 * благословений не раздаёт.
 */
export function blessingPriestsFor(state = {}) {
  const stances = normalizeNpcWorldState(state?.npc_world).stances
  return presentSceneNpcs(state)
    .filter((npc) => npc.visibility !== 'gm_only')
    .filter((npc) => String(stances[String(npc.id)]?.stance ?? 'neutral') !== 'hostile')
    .filter(isPriestProfile)
    .map((npc) => ({ id: String(npc.id), name: text(npc.name, 160), role: text(npc.role, 160) }))
}

export function isBlessingPriest(state = {}, npcId = '') {
  const expected = text(npcId, 120)
  return blessingPriestsFor(state).some((npc) => npc.id === expected)
}

/**
 * Фракции, которым идёт пожертвование. Берутся у профиля жреца тем же
 * помощником, которым их берёт вся репутация (`reputation-policy.mjs`): своей
 * «репутации храма» модуль не заводит — второй реестр разошёлся бы с первым.
 *
 * Пустой список — законный ответ: у жреца без тега `faction:` благодарить
 * некого, и события репутации не будет вовсе.
 */
export function blessingFactionIdsFor(state = {}, npcId = '') {
  const expected = text(npcId, 120)
  const profile = (state?.social?.npcs ?? []).find((npc) => String(npc?.id ?? '') === expected)
  return profile ? factionIdsForNpc(profile) : []
}

// ---------------------------------------------------------------------------
// Знамение
// ---------------------------------------------------------------------------

/**
 * Тревожное знамение на натуральной единице. Чистая функция сида: одинаковый
 * вход — одинаковый выход, поэтому replay рассказывает то же самое.
 */
export function blessingOmenFor(seed = '') {
  return OMENS[Number.parseInt(digest(text(seed, 240), 'omen').slice(0, 8), 16) % OMENS.length]
}

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

/**
 * Карточка благословений для стола. Здесь и только здесь решается, что игрок
 * видит: несёт ли он благословение, прошли ли сутки, у кого в этой сцене можно
 * попросить и сколько стоит пожертвование.
 *
 * Функция одна на оба канала — проекцию состояния и канал событий: второго
 * ответа на вопрос «что с благословением» быть не должно.
 */
export function blessingsForViewer(state = {}, viewer = {}) {
  const heroId = text(viewer?.playerId, 120)
  const atMinutes = Math.max(0, integer(state?.mechanics?.world_time?.elapsed_minutes, 0))
  const availability = blessingAvailabilityFor(state, heroId, atMinutes)
  const record = blessingRecordFor(state, heroId)
  return {
    schema_version: BLESSINGS_SCHEMA_VERSION,
    condition: BLESSING_CONDITION,
    attack_bonus: BLESSING_ATTACK_BONUS,
    donation_cp: BLESSING_DONATION_CP,
    prayer_dc: PRAYER_DC,
    prayer_skill: PRAYER_SKILL,
    location_id: sceneLocationId(state),
    blessed: heroIsBlessed(state, heroId),
    available: availability.available,
    waits_minutes: availability.waits_minutes,
    priests: blessingPriestsFor(state),
    // Чем кончилось прошлое обращение. Нужно карточке ровно для одной строки:
    // «сегодня уже молились» без ответа на «и что» читается как сбой.
    last: record ? {
      source: record.source,
      granted: record.granted,
      place_name: record.place_name,
      npc_name: record.npc_name,
      at_minutes: record.at_minutes,
    } : null,
  }
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/**
 * Что событие меняет в реестре благословений. Реестр выводится из журнала
 * целиком, поэтому replay воспроизводит и суточный слот, и то, чем кончилось
 * обращение.
 *
 * `GAME_STATE_PROJECTOR_VERSION` из-за этой ветки **не двигается**: снимок
 * старой версии не содержит ни одного события благословения просто потому, что
 * таких событий тогда не существовало, — а всякий снимок, в котором они есть,
 * пишется уже новым кодом и несёт срез вместе с ними.
 */
export function applyBlessingEvent(input, event, _state = {}) {
  const type = String(event?.event_type ?? '')
  if (type !== 'ShrinePrayerResolved' && type !== 'NpcBlessingGranted') {
    return input?.schema_version === BLESSINGS_SCHEMA_VERSION && input?.heroes ? input : normalizeBlessingState(input)
  }
  const normalized = input?.schema_version === BLESSINGS_SCHEMA_VERSION && input?.heroes ? input : normalizeBlessingState(input)
  const payload = event?.payload ?? {}
  const heroId = text(payload.hero_id ?? event?.actor_id, 120)
  if (!heroId) return normalized
  return normalizeBlessingState({
    ...normalized,
    heroes: {
      ...normalized.heroes,
      [heroId]: {
        at_minutes: Math.max(0, integer(payload.at_minutes, 0)),
        source: type === 'NpcBlessingGranted' ? 'priest' : 'shrine',
        // Молчание и знамение сутки закрывают, но благословением не являются.
        granted: type === 'NpcBlessingGranted' || text(payload.outcome, 20) === 'blessed',
        place_name: text(payload.place_name, 180),
        npc_id: text(payload.npc_id, 120),
        npc_name: text(payload.npc_name, 160),
      },
    },
  })
}
