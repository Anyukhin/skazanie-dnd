import type { ReactNode } from 'react'
import type { SpellComponents } from './types'
import { CombatIcon } from './CombatIcon'
import { damageTypeLabel } from './app-shared'
import { conditionPresentation } from './tactical-ui'

export type SpellbookSpell = {
  id: string
  name: string
  englishName?: string
  level: number
  kind?: string | null
  target?: string | null
  actionType?: string | null
  school?: string | null
  castingTime?: string | null
  range?: number | null
  rangeText?: string | null
  components?: SpellComponents | null
  ritual?: boolean | null
  concentration?: boolean | null
  duration?: string | null
  description?: string | null
  classes?: readonly string[] | null
  /** Полный список классов из source facts; не используется для runtime-доступа. */
  sourceClasses?: readonly string[] | null
  subclasses?: readonly string[] | null
  subclass?: string | readonly string[] | null
  sourceBooks?: readonly string[] | null
  sourceFetchedAt?: string | null
  sourceHashFnv1a64?: string | null
  higherLevels?: string | null
  upcast?: string | null
  upcastText?: string | null
  sourceUrl?: string | null
  prepared?: boolean
  mechanicsSupport?: string | null
  supportNote?: string | null
  componentAvailability?: { available?: boolean; reason?: string | null } | null
  damage?: string | null
  damageType?: string | null
  damageTypes?: readonly string[] | null
  healing?: string | null
  addAbilityModifier?: boolean | null
  saveAbility?: string | null
  saveDamage?: string | null
  halfOnSave?: boolean | null
  radius?: number | null
  areaShape?: string | null
  areaSideFeet?: number | null
  maxTargets?: number | null
  projectileCount?: number | null
  createsAreaEffect?: { condition?: string | null } | null
  upcastDicePerLevel?: number | null
  upcastHealingDicePerLevel?: number | null
  upcastTargetsPerLevel?: number | null
  upcastProjectilesPerLevel?: number | null
  upcastBeamsPerLevel?: number | null
  upcastSummonsPerLevel?: number | null
  temporaryHpPerUpcastLevel?: number | null
  hitPointPoolUpcastDice?: string | null
  nextWeaponHit?: { upcastDicePerLevel?: number | null } | null
  secondaryBurst?: { upcastDicePerLevel?: number | null } | null
}

const CLASS_LABELS: Record<string, string> = {
  artificer: 'изобретатель', barbarian: 'варвар', bard: 'бард', cleric: 'жрец',
  druid: 'друид', fighter: 'воин', monk: 'монах', paladin: 'паладин', ranger: 'следопыт',
  rogue: 'плут', sorcerer: 'чародей', warlock: 'колдун', wizard: 'волшебник',
}

const ABILITY_LABELS: Record<string, string> = { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' }
const TARGET_LABELS: Record<string, string> = { enemy: 'враг', ally: 'союзник', self: 'на себя', point: 'точка', creature: 'существо' }
const KIND_LABELS: Record<string, string> = { attack: 'атака', save: 'спасбросок', 'area-save': 'область со спасброском', damage: 'урон', 'area-damage': 'область с уроном', healing: 'лечение', summon: 'призыв', buff: 'усиление', debuff: 'ослабление', utility: 'утилита', teleport: 'телепорт' }
const SHAPE_LABELS: Record<string, string> = { sphere: 'сфера', cone: 'конус', line: 'линия', cube: 'куб', cylinder: 'цилиндр' }
const RUNTIME_CONDITION_LABELS: Record<string, string> = { deafened: 'Оглохший', 'magical-darkness': 'Магическая тьма' }

const trimTerminalPunctuation = (value: string) => value.trim().replace(/[.!?]+$/u, '')

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function localizedClass(value: string) {
  return CLASS_LABELS[value.toLocaleLowerCase('en')] ?? value
}

function runtimeConditionLabel(id: string) {
  return RUNTIME_CONDITION_LABELS[id] ?? conditionPresentation({ id }).label
}

function listLabel(value: unknown, localize = false) {
  const items = listValue(value).map((item) => localize ? localizedClass(item) : item)
  return items.length ? items.join(', ') : 'Не указано в каталоге'
}

export function spellLevelLabel(level: number | null | undefined) {
  const normalized = Number(level)
  return normalized === 0 ? 'Заговор' : Number.isFinite(normalized) && normalized > 0 ? `${normalized} круг` : 'Не указан'
}

export function spellRangeLabel(spell: Pick<SpellbookSpell, 'rangeText' | 'range'>) {
  const text = typeof spell.rangeText === 'string' ? spell.rangeText.trim() : ''
  if (text) return text
  const range = Number(spell.range)
  return Number.isFinite(range) && range >= 0 ? `${range} футов` : 'Не указана'
}

/** Источник корпуса 5e 2014: меняется только одобренный host, путь остаётся тем же. */
export function sourceUrlForSpell(spell: Pick<SpellbookSpell, 'sourceUrl' | 'sourceBooks'>): string | null {
  const raw = typeof spell.sourceUrl === 'string' ? spell.sourceUrl.trim() : ''
  if (!raw) return null
  if (!spell.sourceBooks?.length) return raw
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' && (url.hostname === 'dnd.su' || url.hostname === 'www.dnd.su')) url.hostname = '5e14.dnd.su'
    return url.toString()
  } catch {
    return raw
  }
}

export function spellComponentsText(components?: SpellComponents | null) {
  if (!components) return 'Не указаны в каталоге'
  const markers = [components.verbal ? 'В' : null, components.somatic ? 'С' : null, components.material ? 'М' : null]
    .filter((marker): marker is string => Boolean(marker))
  if (components.special?.length) markers.push('А')
  return markers.length ? markers.join(' · ') : 'Нет компонентов'
}

function materialDetails(material: NonNullable<SpellComponents['material']>) {
  const details = [material.description.trim()]
  if (material.costGp != null) details.push(`${material.costGp} зм`)
  if (material.consumed) details.push('расходуется')
  if (material.focusSubstitutable && !material.unresolved) details.push('можно заменить фокусом')
  if (material.requirementNote) details.push(trimTerminalPunctuation(material.requirementNote))
  return details.join(' · ')
}

export function spellComponentDetails(components?: SpellComponents | null): string[] {
  if (!components) return ['Данные о компонентах отсутствуют в каталоге.']
  const details = [`Компоненты: ${spellComponentsText(components)}`]
  if (components.material) details.push(`Материальный компонент: ${materialDetails(components.material)}`)
  if (components.special?.length) details.push(...components.special.map((item) => `Особое требование: ${item.description}`))
  if (!components.material && !components.special?.length) details.push('Материальный компонент не требуется.')
  return details
}

export function spellRuntimeDetails(spell: SpellbookSpell): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  const damageTypes = listValue(spell.damageTypes ?? spell.damageType).map((type) => damageTypeLabel(type) || type).join(', ')
  if (spell.damage) rows.push(['Урон', `${spell.damage}${damageTypes ? ` · ${damageTypes}` : ''}`])
  if (spell.healing) rows.push(['Лечение', `${spell.healing}${spell.addAbilityModifier ? ' + модификатор характеристики' : ''}`])
  if (spell.kind) rows.push(['Тип эффекта', KIND_LABELS[spell.kind] ?? spell.kind])
  if (spell.target) {
    const targets = Number(spell.maxTargets)
    rows.push(['Цель', `${TARGET_LABELS[spell.target] ?? spell.target}${Number.isFinite(targets) && targets > 1 ? ` · до ${targets}` : ''}`])
  }
  if (spell.saveAbility) rows.push(['Спасбросок', `${ABILITY_LABELS[spell.saveAbility] ?? spell.saveAbility}${spell.saveDamage ? ` · при успехе ${spell.saveDamage}` : spell.halfOnSave ? ' · половина урона при успехе' : ''}`])
  if (spell.areaShape || spell.radius != null || spell.areaSideFeet != null) {
    const shape = spell.areaShape ? SHAPE_LABELS[spell.areaShape] ?? spell.areaShape : 'область'
    const size = spell.areaSideFeet != null
      ? `сторона ${spell.areaSideFeet} футов`
      : spell.radius != null
        ? spell.areaShape === 'cube' ? `сторона ${spell.radius} футов`
          : spell.areaShape === 'cone' ? `длина конуса ${spell.radius} футов`
            : spell.areaShape === 'line' ? `длина линии ${spell.radius} футов`
              : `радиус ${spell.radius} футов`
        : ''
    rows.push(['Область', [shape, size].filter(Boolean).join(' · ')])
  }
  if (spell.projectileCount != null) rows.push(['Снаряды', String(spell.projectileCount)])
  if (spell.createsAreaEffect?.condition) rows.push(['Зона', `состояние: ${runtimeConditionLabel(spell.createsAreaEffect.condition)}`])
  return rows
}

function structuredUpcast(spell: SpellbookSpell) {
  const lines: string[] = []
  const add = (value: number | null | undefined, label: string) => {
    if (value != null && Number.isFinite(Number(value)) && Number(value) > 0) lines.push(`+${value} ${label} за каждый круг ячейки выше базового`)
  }
  add(spell.upcastDicePerLevel, 'кость')
  add(spell.upcastHealingDicePerLevel, 'лечебную кость')
  add(spell.upcastTargetsPerLevel, 'цель')
  add(spell.upcastProjectilesPerLevel, 'снаряд')
  add(spell.upcastBeamsPerLevel, 'луч')
  add(spell.upcastSummonsPerLevel, 'призыв')
  add(spell.temporaryHpPerUpcastLevel, 'временных хитов')
  if (spell.hitPointPoolUpcastDice) lines.push(`+${spell.hitPointPoolUpcastDice} к пулу хитов за каждый круг ячейки выше базового`)
  add(spell.nextWeaponHit?.upcastDicePerLevel, 'кость урона следующего попадания')
  add(spell.secondaryBurst?.upcastDicePerLevel, 'кость урона вторичного взрыва')
  return lines
}

/**
 * Возвращает данные о повышении из явного поля, override-профиля или полного
 * описания источника. Никакой текст не сочиняется, если каталог его не дал.
 */
export function spellUpcastText(spell: SpellbookSpell): string | null {
  // null — проверенное отсутствие усиления ячейкой. Только undefined
  // сохраняет прежний запасной путь для старых проекций.
  if (spell.higherLevels === null) return null
  for (const value of [spell.higherLevels, spell.upcast, spell.upcastText]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const structured = structuredUpcast(spell)
  if (structured.length) return structured.join('; ')
  const description = typeof spell.description === 'string' ? spell.description : ''
  const sourceSentences = description.split(/(?<=[.!?])\s+/u).filter((sentence) => /ячейк|уровн(?:я|ем|ю|и)?/iu.test(sentence))
  return sourceSentences.length ? sourceSentences.join(' ') : null
}

export type SpellDetailProps = {
  spell: SpellbookSpell
  details?: string | null
  onClose?: () => void
  onSelect?: (spell: SpellbookSpell) => void
  selectLabel?: string
  selectionDisabled?: boolean
  blockedReason?: string | null
  children?: ReactNode
}

export function spellDescriptionParagraphs(spell: Pick<SpellbookSpell, 'description'>, details?: string | null): string[] {
  const text = details?.trim() || spell.description?.trim() || 'Описание отсутствует в каталоге.'
  return text.split(/\r?\n\s*\r?\n/u).map((paragraph) => paragraph.trim()).filter(Boolean)
}

export function SpellDetail({ spell, details, onClose, onSelect, selectLabel = 'Выбрать заклинание', selectionDisabled = false, blockedReason, children }: SpellDetailProps) {
  const componentAvailability = spell.componentAvailability
  const availabilityReason = blockedReason ?? (componentAvailability?.available === false ? componentAvailability.reason : null)
  const supportNote = spell.supportNote?.replace(/\*\*/gu, '').trim() || null
  const runtimeUnsupported = spell.mechanicsSupport === 'heuristic' || spell.mechanicsSupport === 'ruling-only'
  const runtimeUnavailableReason = runtimeUnsupported
    ? supportNote ?? (spell.mechanicsSupport === 'ruling-only'
      ? 'Правило доступно только как оговорка ведущего; серверный эффект не заявлен.'
      : 'Параметры эффекта пока не подтверждены серверными правилами.')
    : null
  const upcast = spellUpcastText(spell)
  const sourceUrl = sourceUrlForSpell(spell)
  const subclasses = listValue(spell.subclasses ?? spell.subclass)
  const runtimeRows = spellRuntimeDetails(spell)
  const factRows: Array<[string, string]> = [
    ['Уровень', spellLevelLabel(spell.level)],
    ['Школа', spell.school?.trim() || 'Не указана в каталоге'],
    ['Время накладывания', spell.castingTime?.trim() || 'Не указано в каталоге'],
    ['Дистанция', spellRangeLabel(spell)],
    ['Длительность', spell.duration?.trim() || 'Не указана в каталоге'],
    ['Ритуал', spell.ritual == null ? 'Не указано в каталоге' : spell.ritual ? 'Да' : 'Нет'],
    ['Концентрация', spell.concentration == null ? 'Не указано в каталоге' : spell.concentration ? 'Да' : 'Нет'],
    ['Классы', listLabel(spell.sourceClasses ?? spell.classes, true)],
    ['Подклассы', subclasses.length ? subclasses.map(localizedClass).join(', ') : Array.isArray(spell.subclasses) ? 'Отдельно не указаны в источнике' : 'Не указаны в каталоге'],
    ['Книга источника', listLabel(spell.sourceBooks)],
  ]
  return <article className="spell-detail" aria-label={`Подробности: ${spell.name}`}>
    <header className="spell-detail-header">
      <CombatIcon id={spell.id} kind="spell" hint={`${spell.name} ${spell.school ?? ''} ${spell.damageType ?? ''}`} size={88} priority />
      <div>
        <h2>{spell.name}</h2>
        {spell.englishName && <p>{spell.englishName}</p>}
      </div>
      {onClose && <button type="button" className="spell-detail-close" onClick={onClose} aria-label="Закрыть подробности">Закрыть</button>}
    </header>
    <dl className="spell-detail-facts">
      {factRows.map(([label, value]) => <div key={label} className={['Классы', 'Подклассы', 'Книга источника'].includes(label) ? 'spell-detail-fact-wide' : undefined}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    {spell.sourceClasses?.some((label) => label.includes('(TCE)')) && <p>Пометка TCE обозначает расширенный список заклинаний класса из книги Таши.</p>}
    <section className="spell-detail-section" aria-labelledby={`spell-components-${spell.id}`}>
      <h3 id={`spell-components-${spell.id}`}>Компоненты</h3>
      {spellComponentDetails(spell.components).map((line) => <p key={line}>{line}</p>)}
    </section>
    <section className="spell-detail-section" aria-labelledby={`spell-description-${spell.id}`}>
      <h3 id={`spell-description-${spell.id}`}>Описание</h3>
      <div className="spell-detail-description">
        {spellDescriptionParagraphs(spell, details).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </div>
    </section>
    <section className="spell-detail-section" aria-labelledby={`spell-runtime-${spell.id}`}>
      <h3 id={`spell-runtime-${spell.id}`}>Эффект в игре</h3>
      {runtimeUnavailableReason
        ? <p className="spell-detail-runtime-unavailable">{runtimeUnavailableReason}</p>
        : runtimeRows.length
          ? <dl className="spell-detail-runtime">{runtimeRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          : <p>Характеристики эффекта пока не указаны.</p>}
    </section>
    <section className="spell-detail-section" aria-labelledby={`spell-upcast-${spell.id}`}>
      <h3 id={`spell-upcast-${spell.id}`}>Повышение уровня</h3>
      <p className="spell-detail-upcast">{spell.higherLevels === null
        ? spell.level === 0
          ? 'Заговор не использует ячейки; масштабирование по уровню персонажа указано в описании.'
          : 'Усиление ячейкой более высокого круга не предусмотрено.'
        : upcast || 'Отдельные сведения о повышении уровня отсутствуют в каталоге.'}</p>
    </section>
    {(availabilityReason || supportNote) && <section className="spell-detail-section spell-detail-status" aria-label="Ограничения применения">
      {availabilityReason && <p role="status"><strong>Сейчас недоступно для применения:</strong> {availabilityReason}</p>}
      {supportNote && !runtimeUnsupported && <p><strong>Особенности применения:</strong> {supportNote}</p>}
      <p>Подробности карточки доступны для чтения.</p>
    </section>}
    {children}
    <footer className="spell-detail-footer">
      {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">Источник каталога</a> : <span>Источник не указан в каталоге</span>}
      {onSelect && <button type="button" onClick={() => onSelect(spell)} disabled={selectionDisabled}>{selectLabel}</button>}
    </footer>
  </article>
}
