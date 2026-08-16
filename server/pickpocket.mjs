/**
 * Карманная кража у NPC.
 *
 * Карман здесь **выводится, а не хранится**. Соблазн был обратный — завести
 * поле в социальном профиле, — но профиль приезжает из админского импорта и
 * из команды Режиссёра, а всё, что в нём лежит, надо и валидировать в строгом
 * белом списке (`normalizeProfileInput`), и закрывать в проекции, и мигрировать.
 * Карман от этого ничего не выигрывает: он полностью определяется сидом
 * кампании и ролью человека, поэтому один и тот же сид даёт один и тот же
 * кошелёк после replay и рестарта — ровно как инвентарь противника
 * (`server/enemy-loadouts.mjs`) и характер соперника за костями
 * (`server/tavern-life.mjs`), у которых та же природа.
 *
 * **Карман — не витрина.** Торговый инвентарь у торговца свой, и трогать его
 * кража не имеет права: обчистить лавку на весь склад — это уже ограбление, а
 * не ловкость рук. Отсюда маленький честный пул: пара медяков и, изредка, одна
 * мелочь по роли.
 */
import { createHash } from 'node:crypto'

import { catalogItem } from './item-catalog.mjs'

export const PICKPOCKET_POLICY_ID = 'skazanie:pickpocket-v1'
export const PICKPOCKET_SKILL = 'sleight_of_hand'
export const PICKPOCKET_ABILITY = 'dex'

/**
 * Насколько людно вокруг. Толпа помогает вору — в толчее рука в чужом кармане
 * теряется, — а разговор наедине не оставляет ни одного лишнего плеча, за
 * которым можно спрятаться. Ступени закрыты и считаются по числу людей в
 * сцене, а не по описанию: описание пишет модель, а правило обязано быть
 * серверным.
 */
export const PICKPOCKET_CROWD_STEPS = Object.freeze([
  { minimum: 6, shift: -3, label: 'в толчее' },
  { minimum: 3, shift: -1, label: 'при людях' },
  { minimum: 2, shift: 0, label: 'вдвоём с кем-то ещё' },
  { minimum: 0, shift: 3, label: 'наедине' },
])

/** Границы СЛ. Ниже — не кража, выше — не попытка. */
export const PICKPOCKET_MIN_DC = 5
export const PICKPOCKET_MAX_DC = 25

/**
 * Сколько медяков лежит у человека в кармане, по роли, и что там ещё может
 * быть. Вещи выбраны из того, что действительно есть в каталоге снаряжения и
 * действительно помещается в карман: паёк, факел, моток верёвки, кинжал на
 * поясе стражника. Кошелёк торговца тяжелее нищенского, но это по-прежнему
 * карман, а не касса — витрину кража не трогает вовсе.
 */
const PURSE_BY_ROLE = Object.freeze([
  { test: /куп|торг|лавоч|менял|ростовщ/iu, base: 40, spread: 60, item: 'srd_5_2_1:rations-one-day' },
  { test: /жрец|служ|монах|настоятел/iu, base: 15, spread: 25, item: 'srd_5_2_1:torch' },
  { test: /страж|солдат|воин|наём|десятн|сотник/iu, base: 25, spread: 35, item: 'srd_5_2_1:dagger' },
  { test: /кузнец|ремесл|мастер|плотн/iu, base: 20, spread: 30, item: 'srd_5_2_1:rope-hempen-50-feet' },
  { test: /нищ|бродяг|попрош/iu, base: 2, spread: 6, item: '' },
  { test: /крест|пахар|рыбак|пасту/iu, base: 6, spread: 12, item: 'srd_5_2_1:rations-one-day' },
])

const DEFAULT_PURSE = Object.freeze({ base: 10, spread: 20, item: 'srd_5_2_1:torch' })

/** Один шанс из трёх, что кроме монет в кармане есть мелочь. */
const POCKET_ITEM_SHARE = 33

const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback)

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

function spread(seed, salt, size) {
  return Number.parseInt(digest(seed, salt).slice(0, 8), 16) % Math.max(1, size)
}

/**
 * Что лежит у человека в кармане прямо сейчас.
 *
 * Возвращает и монеты, и, может быть, одну вещь. Вещь берётся из каталога и
 * проверяется по нему же: запись, которой в каталоге нет, молча выпадает —
 * выдумывать предмет по строке роли этот модуль не имеет права.
 */
export function npcPocketFor(state = {}, npc = {}) {
  const id = text(npc?.id, 120)
  if (!id) return null
  const role = `${text(npc?.role, 160)} ${text(npc?.name, 160)}`
  const profile = PURSE_BY_ROLE.find((candidate) => candidate.test.test(role)) ?? DEFAULT_PURSE
  const seed = digest(text(state?.sessionCode, 60), id, PICKPOCKET_POLICY_ID)
  const purseCp = Math.max(1, profile.base + spread(seed, 'purse', Math.max(1, profile.spread)))
  const carriesItem = profile.item && spread(seed, 'has-item', 100) < POCKET_ITEM_SHARE
  const entry = carriesItem ? catalogItem(profile.item) : null
  return Object.freeze({
    npc_id: id,
    purse_cp: purseCp,
    catalog_id: entry ? entry.catalog_id : null,
  })
}

/**
 * Насколько человек внимателен к своим карманам.
 *
 * Своей «пассивной Проницательности» у социального профиля нет — общего листа
 * у NPC вообще нет, — поэтому она выводится тем же способом, что у соперника
 * за костями: `10 + разброс от сида`. Формула та же намеренно: два разных
 * числа «насколько он замечает чужие руки» в одной игре читались бы как
 * ошибка.
 */
export function npcPassiveInsightFor(state = {}, npc = {}) {
  const id = text(npc?.id, 120)
  if (!id) return 10
  const seed = digest(text(state?.sessionCode, 60), id, 'npc-insight')
  return 10 + spread(seed, 'attention', 5)
}

/** Ступень людности по числу людей вокруг вора и жертвы. */
export function pickpocketCrowdStep(presentCount) {
  const count = Math.max(0, integer(presentCount, 0))
  return PICKPOCKET_CROWD_STEPS.find((step) => count >= step.minimum) ?? PICKPOCKET_CROWD_STEPS.at(-1)
}

/**
 * СЛ карманной кражи: внимание жертвы плюс поправка на людность.
 *
 * Число собирается в одном месте и обеими фазами ручного броска читается
 * одинаково — карточка проверки объявляет ровно ту СЛ, которую применит движок.
 * Прятать её, как прячут СЛ социальной проверки, здесь не за чем: это
 * проверка Ловкости против чужого внимания, а не разговор, и «он выглядит
 * настороженным» — честная информация за столом.
 */
export function pickpocketDifficultyFor(state = {}, npc = {}, presentCount = 0) {
  const step = pickpocketCrowdStep(presentCount)
  const raw = npcPassiveInsightFor(state, npc) + step.shift
  return {
    difficulty: Math.max(PICKPOCKET_MIN_DC, Math.min(PICKPOCKET_MAX_DC, raw)),
    crowd_label: step.label,
    crowd_shift: step.shift,
  }
}
