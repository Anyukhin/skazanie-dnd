import { createHash } from 'node:crypto'

import { backgroundBenefits } from './backgrounds.mjs'

/**
 * Взлом отмычками: кто вправе его пробовать, чем он шумит и когда сорванный
 * замок замечают.
 *
 * Модуль детерминированный и **листовой**: он читает переданного героя и
 * состояние кампании, но ничего из механики не зовёт. Броски остаются за Rules
 * Engine, а здесь — только политика.
 *
 * Три решения, каждое из которых стоило отдельного разговора:
 *
 * 1. **Гейт — владение, а не предмет.** Записи «воровские инструменты» в
 *    каталоге вещей нет и в этой волне не заводится: без картинки предмет
 *    встал бы в инвентарь безымянной строкой. Поэтому работает правило стола
 *    «инструменты при владеющем подразумеваются»: вскрывать замок вправе тот,
 *    кому владение дала предыстория (`data/backgrounds-srd-5-2-1.json`), и
 *    больше никто. Ограничение записано в `docs/known-limitations.md` —
 *    выкинуть отмычки из рюкзака или отобрать их пока нельзя.
 * 2. **СЛ замка игроку не объявляется.** Бросок серверный, карточки первой
 *    фазы у взлома нет — ровно как у выламывания двери силой. Замок тем и
 *    замок, что заранее не знаешь, поддастся ли.
 * 3. **Шум — не бросок.** Услышали или нет, решает присутствие людей в сцене,
 *    а натуральная единица делает шум громче. Ломать инструмент при этом
 *    нечего: предмета в игре нет, и «отмычка сломалась» было бы выдумкой о
 *    вещи, которой не существует.
 */

export const LOCKPICKING_POLICY_ID = 'skazanie:lockpicking-v1'
export const LOCKPICKING_SCHEMA_VERSION = 1

/** Идентификатор владения из каталога предысторий. Второго написания нет. */
export const THIEVES_TOOLS_ID = 'thieves_tools'

/** Как инструменты зовут за столом. Латиницу игрок не увидит никогда. */
export const THIEVES_TOOLS_NAME = 'воровские инструменты'

/** Отказ без владения. Один текст на движок, проекцию и кнопку. */
export const THIEVES_TOOLS_REQUIRED_MESSAGE = 'Нужно владение воровскими инструментами'

/** Код отказа без владения. */
export const THIEVES_TOOLS_REQUIRED_CODE = 'THIEVES_TOOLS_REQUIRED'

/**
 * Ступень поступка за шум. Провал — мелочь: звякнул металл, кто-то обернулся.
 * Натуральная единица — средняя ступень: отмычка сорвалась, и грохот слышали
 * все. Тяжкой ступени у шума нет и быть не может — это возня у замка, а не
 * пролитая кровь.
 */
export const LOCKPICK_NOISE_SEVERITY = Object.freeze({ failure: 'minor', fumble: 'major' })

/**
 * Доля сорванных замков, которые замечают при живых людях в сцене. Не бросок:
 * один и тот же взлом на одном и том же состоянии обязан кончаться одинаково и
 * после replay — тот же приём, что у доноса честного торговца
 * (`fenceDenunciationFor`, `server/underworld.mjs`).
 */
export const LOCKPICK_TRACE_SHARE = 25

const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const list = (value) => (Array.isArray(value) ? value : []).map((entry) => text(entry, 120)).filter(Boolean)

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

function spread(seed, salt, size) {
  return Number.parseInt(digest(seed, salt).slice(0, 8), 16) % Math.max(1, size)
}

/**
 * Все места, где на листе может лежать владение инструментом. Порядок значения
 * не имеет: достаточно одного совпадения.
 *
 * Терпимость к формам — та же, что у `skillProficiencyForActor`
 * (`server/rules-engine.mjs`): лист приезжает контрактом импорта, и у
 * перенесённых персонажей соседние написания встречаются.
 */
function declaredToolIds(actor) {
  return [
    ...list(actor?.toolProficiencies),
    ...list(actor?.toolProficiencyIds),
    ...list(actor?.characterSheet?.tool_proficiencies),
    ...list(actor?.characterSheet?.tools),
    text(actor?.backgroundBenefits?.tool_proficiency, 120),
  ].filter(Boolean)
}

/**
 * Владеет ли герой воровскими инструментами.
 *
 * Источник истины — предыстория: `backgroundId` хранится в документе героя и
 * переживает replay, а разбор её последствий (`withBackgroundBenefits`) на
 * листе бывает не всегда — состояния из бутстрапа и админского импорта до него
 * не доходят. Поэтому предыстория перечитывается по идентификатору, а уже
 * достроенный разбор принимается как готовый ответ.
 */
export function hasThievesTools(actor) {
  if (!actor || typeof actor !== 'object') return false
  if (declaredToolIds(actor).includes(THIEVES_TOOLS_ID)) return true
  const backgroundId = text(actor.backgroundId, 120)
  if (!backgroundId) return false
  return text(backgroundBenefits(backgroundId)?.tool_proficiency, 120) === THIEVES_TOOLS_ID
}

/**
 * Карточка взлома для стола. Отвечает ровно на один вопрос — «этот герой умеет
 * вскрывать замки?», — и отвечает **готовой строкой отказа**, а не признаком, из
 * которого клиенту пришлось бы её сочинять: текст отказа обязан совпасть с тем,
 * которым движок отвергнет команду, иначе кнопка и сервер разойдутся в
 * объяснении.
 *
 * Ни СЛ, ни запертости в карточке нет и быть не может: запертость сундука
 * выводится из сида, и объяви её проекция — игрок читал бы наличие замка, не
 * притронувшись к крышке.
 */
export function lockpickingForViewer(state = {}, { playerId = '' } = {}) {
  const heroId = text(playerId, 120)
  const hero = (Array.isArray(state?.players) ? state.players : [])
    .find((player) => text(player?.id, 120) === heroId) ?? null
  const proficient = hasThievesTools(hero)
  return {
    schema_version: LOCKPICKING_SCHEMA_VERSION,
    policy_id: LOCKPICKING_POLICY_ID,
    tool_id: THIEVES_TOOLS_ID,
    tool_name: THIEVES_TOOLS_NAME,
    proficient,
    blocked_reason: proficient ? '' : THIEVES_TOOLS_REQUIRED_MESSAGE,
  }
}

/**
 * Шум неудачной попытки. `null` — тишина: удачный взлом на то и удачный, что
 * его не слышали.
 *
 * @param {{ success?: boolean, natural?: number }} check
 * @returns {{ reason: 'noise', severity: 'minor'|'major', loud: boolean } | null}
 */
export function lockpickNoiseFor(check = {}) {
  if (check?.success === true) return null
  const loud = Number(check?.natural) === 1
  return {
    reason: 'noise',
    severity: loud ? LOCKPICK_NOISE_SEVERITY.fumble : LOCKPICK_NOISE_SEVERITY.failure,
    loud,
  }
}

/**
 * Заметил ли кто-нибудь сорванный замок после **удачного** взлома. Тот же
 * детерминированный приём, что и донос скупщика: доля, а не кость.
 *
 * Свидетели приходят снаружи — их считает сцена, а не этот модуль: список
 * живых NPC вокруг есть только у движка.
 *
 * @param {Record<string, any>} state
 * @param {{ targetId?: string, witnessIds?: string[] }} where
 * @returns {{ reason: 'trace', severity: 'minor', loud: false } | null}
 */
export function lockpickTraceNoticedFor(state = {}, { targetId = '', witnessIds = [] } = {}) {
  const witnesses = list(witnessIds)
  if (!witnesses.length) return null
  const seed = digest(
    text(state?.sessionCode, 60),
    text(state?.worldMap?.currentLocationId ?? state?.scene?.location, 180),
    text(targetId, 160),
    witnesses.join(','),
    LOCKPICKING_POLICY_ID,
  )
  if (spread(seed, 'trace', 100) >= LOCKPICK_TRACE_SHARE) return null
  return { reason: 'trace', severity: 'minor', loud: false }
}
