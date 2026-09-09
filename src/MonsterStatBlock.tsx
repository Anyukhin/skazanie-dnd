import { useEffect, useMemo, useState } from 'react'
import { ABILITY_LABELS, SKILL_LABELS, damageTypeLabel } from './app-shared'

export type MonsterAbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

type ArmorClass = {
  value?: number | null
  details_ru?: string | null
  alternatives?: Array<{ value?: number | null; requires_spell?: string | null }>
}

type HitPoints = { average?: number | null; formula?: string | null }
type Range = { normal?: number | null; long?: number | null }
type DamagePart = { expression?: string | null; amount?: number | null; type?: string | null; average?: number | null }
type SequencePart = { action_id?: string | null; count?: number | null }
type Sequence = SequencePart[]

type Save = { ability?: string | null; dc?: number | null; success?: string | null }
type Recharge = { die?: string | null; success?: number[]; check?: string | null }
type Area = { shape?: string | null; length_ft?: number | null; radius_ft?: number | null; width_ft?: number | null }

type Effect = {
  save?: Save | null
  save_ability?: string | null
  save_dc?: number | null
  dc?: number | null
  save_success?: string | null
  on_failure?: Effect | string | null
  repeat_save?: { timing?: string; ability?: string; dc?: number } | string | null
  condition?: string | null
  damage_expression?: string | null
  damage_type?: string | null
  damage?: DamagePart | string | null
  duration?: string | null
  duration_minutes?: number | null
  escape?: Effect | null
}

export type MonsterFeature = {
  id?: string
  name_ru?: string
  summary_ru?: string | null
}

export type MonsterAction = MonsterFeature & {
  kind?: string
  attack_modifier?: number | null
  target?: string | null
  modes?: string[]
  reach_ft?: number | null
  range_ft?: Range | null
  damage?: DamagePart[]
  versatile_damage?: string | null
  ranged_damage?: string | null
  sequences?: Sequence[]
  conditions?: Array<{ requires?: string } | null>
  on_hit?: Effect | null
  recharge?: Recharge | null
  move_up_to?: number | string | null
  max_target_size?: string | null
  save?: Save | null
  on_failure?: Effect | string | null
  ongoing?: Effect | string | null
  escape?: Effect | string | null
  area?: Area | null
  uses?: number | string | null
}

type LanguageInfo = {
  spoken?: string[]
  understood_only?: string[]
  notes_ru?: string | null
}

type Defense = string | { types?: string[]; condition?: string | null }

type Spell = { key?: string; name_ru?: string }
type SpellSlot = { level?: number; slots?: number | null; spells?: Spell[] }
type InnateSpellGroup = { uses?: number | string; spells?: Spell[] }
type Spellcasting = {
  kind?: string
  caster_level?: number | null
  class?: string | null
  ability?: string | null
  save_dc?: number | null
  attack_modifier?: number | null
  casting_mode?: string | null
  components_required?: string[]
  components_not_required?: string[]
  spell_slots?: SpellSlot[]
  innate_spells?: InnateSpellGroup[]
  notes_ru?: string | null
}

export type MonsterStatBlockRecord = {
  id?: string
  name_ru?: string
  name_en?: string
  book_code?: string
  source_url?: string
  size?: string
  creature_type?: string
  subtypes?: string[]
  alignment?: string | null
  armor_class?: ArmorClass
  hit_points?: HitPoints
  speed_ft?: Record<string, number | boolean | null>
  abilities?: Partial<Record<MonsterAbilityKey, number>>
  ability_modifiers?: Partial<Record<MonsterAbilityKey, number>>
  saving_throws?: Record<string, number>
  skills?: Record<string, number>
  senses?: Record<string, number | boolean | string | null>
  languages?: LanguageInfo
  challenge_rating?: string | number
  xp?: number
  proficiency_bonus?: number
  initiative_bonus?: number
  damage_resistances?: Defense[]
  damage_immunities?: Defense[]
  damage_vulnerabilities?: Defense[]
  condition_immunities?: string[]
  traits?: MonsterFeature[]
  actions?: MonsterAction[]
  bonus_actions?: MonsterAction[]
  reactions?: MonsterAction[]
  legendary_actions?: MonsterAction[]
  lair_actions?: MonsterAction[]
  spellcasting?: Spellcasting | null
  habitats?: string[]
  lore?: { summary_ru?: string | null; source_url?: string | null }
}

export type MonsterCatalogEntry = {
  id: string
  name: string
  cr: string | number
  hp: number
  ac?: number
  sourceUrl: string
  image?: string
  images?: string[]
  limitations?: string[] | string
  statBlock?: MonsterStatBlockRecord | null
}

const ABILITY_KEYS: MonsterAbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const SIZE_LABELS: Record<string, string> = {
  tiny: 'крошечный', small: 'маленький', medium: 'средний', large: 'большой', huge: 'огромный', gargantuan: 'гигантский',
}
const CREATURE_TYPE_LABELS: Record<string, string> = {
  aberration: 'аберрация', beast: 'зверь', celestial: 'небожитель', construct: 'конструкт', dragon: 'дракон',
  elemental: 'элементаль', fey: 'фея', fiend: 'исчадие', giant: 'великан', humanoid: 'гуманоид',
  monstrosity: 'чудовище', ooze: 'слизь', plant: 'растение', undead: 'нежить',
}
const SUBTYPE_LABELS: Record<string, string> = { goblinoid: 'гоблиноид', kobold: 'кобольд', orc: 'орк', shapechanger: 'перевёртыш', gnoll: 'гнолл', 'any-race': 'любая раса', devil: 'дьявол', demon: 'демон', human: 'человек' }
const ALIGNMENT_LABELS: Record<string, string> = {
  lawful_good: 'законопослушный добрый', neutral_good: 'нейтральный добрый', chaotic_good: 'хаотичный добрый',
  lawful_neutral: 'законопослушный нейтральный', neutral: 'нейтральный', chaotic_neutral: 'хаотичный нейтральный',
  lawful_evil: 'законопослушный злой', neutral_evil: 'нейтральный злой', chaotic_evil: 'хаотичный злой', unaligned: 'без мировоззрения',
}
const SPEED_LABELS: Record<string, string> = { walk: 'ходьба', fly: 'полёт', swim: 'плавание', climb: 'лазание', burrow: 'копание' }
const SENSE_LABELS: Record<string, string> = { blindsight_ft: 'слепое зрение', darkvision_ft: 'тёмное зрение', tremorsense_ft: 'чувство вибраций', truesight_ft: 'истинное зрение', passive_perception: 'пассивное Восприятие' }
const LANGUAGE_LABELS: Record<string, string> = {
  gnoll: 'гнолльский', auran: 'ауранский', terran: 'терранский', aquan: 'акванский', all: 'все языки',
  creator_languages: 'языки создателя', one_creator_language: 'один язык создателя', creator_language: 'язык создателя', languages_known_in_life: 'языки, известные при жизни',
  common: 'Общий', goblin: 'гоблинский', draconic: 'драконий', orc: 'орочий', giant: 'великанский', abyssal: 'язык Бездны',
  ignan: 'игнанский', primordial: 'первичный', infernal: 'инфернальный', celestial: 'небесный', undercommon: 'подземный',
  sylvan: 'сильван', elvish: 'эльфийский', dwarvish: 'дварфский', deep_speech: 'глубинная речь', telepathy: 'телепатия',
}
const CONDITION_LABELS: Record<string, string> = {
  blinded: 'ослепление', charmed: 'очарование', deafened: 'глухота', frightened: 'испуг', grappled: 'схвачен',
  incapacitated: 'недееспособность', invisible: 'невидимость', paralyzed: 'паралич', petrified: 'окаменение',
  poisoned: 'отравление', prone: 'сбит с ног', restrained: 'опутанность', stunned: 'ошеломление', unconscious: 'без сознания',
  exhaustion: 'истощение', burning: 'горение',
}
const DEFENSE_CONDITIONS: Record<string, string> = {
  'nonmagical-attacks': 'только против немагических атак',
  'except-silvered': 'кроме посеребрённых атак',
  'except-adamantine': 'кроме адамантинового оружия',
  'nonmagical-attacks-except-silvered': 'только против немагических атак, кроме посеребрённых',
  'nonmagical-attacks-except-adamantine': 'только против немагических атак, кроме адамантинового оружия',
}
const ACTION_MODE_LABELS: Record<string, string> = { melee: 'рукопашная', ranged: 'дальняя' }
const TARGET_LABELS: Record<string, string> = { one_target: 'одна цель', one_creature: 'одно существо', all_creatures: 'все существа' }
const SAVE_SUCCESS_LABELS: Record<string, string> = { half_damage: 'половина урона', no_damage: 'нет урона' }
const AREA_LABELS: Record<string, string> = { cone: 'конус', sphere: 'сфера', cube: 'куб', line: 'линия', cylinder: 'цилиндр' }
const SPELL_CLASS_LABELS: Record<string, string> = { cleric: 'жрец', wizard: 'волшебник', druid: 'друид', sorcerer: 'чародей', warlock: 'колдун', bard: 'бард', paladin: 'паладин', ranger: 'следопыт' }
const COMPONENT_LABELS: Record<string, string> = { V: 'вербальный', verbal: 'вербальный', S: 'соматический', somatic: 'соматический', M: 'материальный', material: 'материальный' }

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value).replace('-', '−')
}

function dice(value: string | number | null | undefined): string {
  return String(value ?? '').replace(/(\d+)d(\d+)/giu, '$1к$2')
}

function numberText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

function label(value: string | null | undefined, labels: Record<string, string>, fallback: string): string {
  const key = String(value ?? '').toLowerCase()
  return labels[key] ?? fallback
}

function abilityLabel(value: string | null | undefined): string {
  return ABILITY_LABELS[String(value ?? '').toLowerCase()] ?? 'характеристика'
}

function damageText(part: DamagePart | string): string {
  if (typeof part === 'string') return `урон ${dice(part)}`
  const kind = damageTypeLabel(part.type)
  const average = part.expression && typeof part.average === 'number' ? `, в среднем ${part.average}` : ''
  return `урон ${part.expression ? dice(part.expression) : numberText(part.amount ?? part.average)}${kind ? ` (${kind.toLocaleLowerCase('ru')} урон` : ''}${kind ? `${average})` : average}`
}

function defenseText(defense: Defense): string {
  if (typeof defense === 'string') return damageTypeLabel(defense) || 'особый тип урона'
  const types = (defense.types ?? []).map((type) => damageTypeLabel(type) || 'особый тип урона').join(', ')
  const condition = defense.condition ? (DEFENSE_CONDITIONS[defense.condition] ?? 'с условием из источника') : ''
  return [types || 'особый тип урона', condition].filter(Boolean).join(' — ')
}

function defenseList(values: Defense[] | undefined): string {
  return values?.length ? values.map(defenseText).join('; ') : 'нет'
}

function conditionList(values: string[] | undefined): string {
  return values?.length ? values.map((value) => label(value, CONDITION_LABELS, 'особое состояние')).join(', ') : 'нет'
}

function formatSpeed(speed: Record<string, number | boolean | null> | undefined): string {
  if (!speed) return '—'
  const entries = Object.entries(speed).filter(([, value]) => typeof value === 'number')
  return entries.length ? entries.map(([key, value]) => `${numberText(value as number)} футов (${SPEED_LABELS[key] ?? 'особое перемещение'})`).join(', ') : '—'
}

function formatSenses(senses: Record<string, number | boolean | string | null> | undefined): string {
  if (!senses) return '—'
  const entries = Object.entries(senses).flatMap(([key, value]) => {
    if (key === 'passive_perception' && typeof value === 'number') return [`пассивное Восприятие ${value}`]
    if (key === 'blind_beyond_blindsight' && value === true) return ['слеп за пределами слепого зрения']
    if (typeof value === 'number') return [`${SENSE_LABELS[key] ?? 'особое чувство'} ${value} футов`]
    return []
  })
  return entries.length ? entries.join(', ') : '—'
}

function formatLanguages(languages: LanguageInfo | undefined): string {
  if (!languages) return '—'
  const spoken = (languages.spoken ?? []).map((value) => LANGUAGE_LABELS[value] ?? 'язык из источника')
  const understood = (languages.understood_only ?? []).map((value) => LANGUAGE_LABELS[value] ?? 'язык из источника')
  const parts = spoken.length ? [spoken.join(', ')] : []
  if (understood.length) parts.push(`понимает только: ${understood.join(', ')}`)
  if (languages.notes_ru) parts.push(languages.notes_ru)
  return parts.length ? parts.join('; ') : 'нет указанных языков'
}

function formatEffect(effect: Effect | string | null | undefined): string {
  if (!effect) return ''
  if (typeof effect === 'string') return CONDITION_LABELS[effect] ?? 'особый эффект из источника'
  const parts: string[] = []
  const saveAbility = effect.save_ability ?? effect.save?.ability
  const saveDc = effect.save_dc ?? effect.dc ?? effect.save?.dc
  if (saveAbility || saveDc != null) parts.push(`спасбросок ${abilityLabel(saveAbility)} СЛ ${numberText(saveDc)}`)
  if (effect.damage) parts.push(damageText(effect.damage))
  if (effect.damage_expression) parts.push(damageText({ expression: effect.damage_expression, type: effect.damage_type }))
  if (effect.condition) parts.push(`состояние: ${label(effect.condition, CONDITION_LABELS, 'особое состояние')}`)
  if (effect.on_failure) parts.push(`при провале: ${formatEffect(effect.on_failure)}`)
  if (effect.save_success) parts.push(`при успехе: ${SAVE_SUCCESS_LABELS[effect.save_success] ?? 'эффект смягчается'}`)
  if (effect.duration_minutes != null) parts.push(`длительность: ${effect.duration_minutes} мин.`)
  if (effect.duration && effect.duration_minutes == null) parts.push(`длительность: ${effect.duration === '1_minute' ? '1 минута' : effect.duration === 'until-extinguished' ? 'до тушения' : ['until_long_rest', 'until-target-finishes-long-rest'].includes(effect.duration) ? 'до продолжительного отдыха цели' : 'по условиям источника'}`)
  if (effect.repeat_save) parts.push(typeof effect.repeat_save === 'string' ? 'повторный спасбросок в конце хода цели' : `повторный спасбросок ${abilityLabel(effect.repeat_save.ability)} СЛ ${numberText(effect.repeat_save.dc)} в конце хода цели`)
  if (effect.escape) parts.push(`освобождение: ${formatEffect(effect.escape)}`)
  return parts.join('; ') || 'особый эффект из источника'
}

function formatRecharge(recharge: Recharge | null | undefined): string {
  if (!recharge) return ''
  const success = recharge.success?.length ? ` ${recharge.success.join('–')}` : ''
  const check = recharge.check === 'start_of_turn' ? ' в начале хода' : ''
  return `перезарядка${success}${check}`
}

function formatUses(uses: number | string | null | undefined): string {
  if (uses == null) return ''
  if (uses === 'at-will') return 'по желанию'
  if (uses === 'short_rest') return 'после короткого отдыха'
  if (uses === 'long_rest') return 'после продолжительного отдыха'
  return `${uses}/день`
}

function formatArea(area: Area | null | undefined): string {
  if (!area) return ''
  const shape = AREA_LABELS[area.shape ?? ''] ?? 'область'
  const size = area.length_ft ?? area.radius_ft ?? area.width_ft
  return `область: ${shape}${size != null ? ` ${size} футов` : ''}`
}

function formatActionDetails(action: MonsterAction, actionNames: Map<string, string>): string[] {
  const details: string[] = []
  if (action.attack_modifier != null) details.push(`атака ${signed(action.attack_modifier)}`)
  if (action.modes?.length) details.push(action.modes.map((mode) => ACTION_MODE_LABELS[mode] ?? 'особый способ').join(' / '))
  if (action.target) details.push(`цель: ${TARGET_LABELS[action.target] ?? 'цель из источника'}`)
  if (action.reach_ft != null) details.push(`досягаемость ${action.reach_ft} футов`)
  if (action.range_ft) {
    const normal = action.range_ft.normal
    const long = action.range_ft.long
    if (normal != null) details.push(`дальность ${normal}${long != null ? `/${long}` : ''} футов`)
  }
  if (action.damage?.length) details.push(action.damage.map(damageText).join('; '))
  if (action.versatile_damage) details.push(`двуручный вариант: ${dice(action.versatile_damage)}`)
  if (action.ranged_damage) details.push(`дальний вариант: ${dice(action.ranged_damage)}`)
  if (action.save) {
    details.push(`спасбросок ${abilityLabel(action.save.ability)} СЛ ${numberText(action.save.dc)}${action.save.success ? `; при успехе — ${SAVE_SUCCESS_LABELS[action.save.success] ?? 'смягченный эффект'}` : ''}`)
  }
  if (action.area) details.push(formatArea(action.area))
  if (action.recharge) details.push(formatRecharge(action.recharge))
  if (action.uses != null) details.push(`использований: ${formatUses(action.uses)}`)
  if (action.move_up_to != null) details.push(`перемещение до ${typeof action.move_up_to === 'number' ? `${action.move_up_to} футов` : 'скорости'}`)
  if (action.max_target_size) details.push(`максимальный размер цели: ${label(action.max_target_size, SIZE_LABELS, 'особый')}`)
  if (action.sequences?.length) {
    const sequence = action.sequences.map((parts, index) => parts.map((part) => `${actionNames.get(String(part.action_id)) ?? 'действие из источника'} ×${part.count ?? 1}`).join(', ') + (action.conditions?.[index]?.requires === 'flying' ? ' (в полёте)' : '')).join(' либо ')
    if (sequence) details.push(`серия: ${sequence}`)
  }
  const onHit = formatEffect(action.on_hit)
  if (onHit) details.push(`при попадании: ${onHit}`)
  const onFailure = formatEffect(action.on_failure)
  if (onFailure) details.push(`при провале: ${onFailure}`)
  const ongoing = formatEffect(action.ongoing)
  if (ongoing) details.push(`периодический эффект: ${ongoing}`)
  const escape = formatEffect(action.escape)
  if (escape) details.push(`освобождение: ${escape}`)
  return details.filter(Boolean)
}

function FeatureSection({ title, entries }: { title: string; entries: MonsterFeature[] | undefined }) {
  if (!entries?.length) return null
  return <section className="monster-statblock-section">
    <p className="monster-statblock-label"><strong>{title}</strong></p>
    <ul className="monster-statblock-list">{entries.map((entry, index) => <li key={entry.id ?? `${title}-${index}`}>
      <strong>{entry.name_ru || 'Особенность'}</strong>{entry.summary_ru ? ` — ${entry.summary_ru}` : ' — подробности указаны в источнике.'}
    </li>)}</ul>
  </section>
}

function ActionSection({ title, actions }: { title: string; actions: MonsterAction[] | undefined }) {
  const actionNames = useMemo(() => new Map((actions ?? []).map((action) => [String(action.id ?? ''), action.name_ru || 'действие'])), [actions])
  if (!actions?.length) return null
  return <section className="monster-statblock-section">
    <p className="monster-statblock-label"><strong>{title}</strong></p>
    <ul className="monster-statblock-list">{actions.map((action, index) => {
      const details = formatActionDetails(action, actionNames)
      return <li key={action.id ?? `${title}-${index}`}>
        <strong>{action.name_ru || 'Действие'}</strong>{action.summary_ru ? ` — ${action.summary_ru}` : null}
        {details.length > 0 && <span className="monster-statblock-action-details">{details.join('; ')}.</span>}
        {!action.summary_ru && details.length === 0 && <span className="monster-statblock-action-details">Подробности указаны в источнике.</span>}
      </li>
    })}</ul>
  </section>
}

function SpellcastingSection({ spellcasting }: { spellcasting: Spellcasting | null | undefined }) {
  if (!spellcasting) return null
  const slots = spellcasting.spell_slots ?? []
  const innate = spellcasting.innate_spells ?? []
  const components = (spellcasting.components_required ?? []).map((component) => COMPONENT_LABELS[component] ?? 'компонент из источника')
  const without = (spellcasting.components_not_required ?? []).map((component) => COMPONENT_LABELS[component] ?? 'компонент из источника')
  return <section className="monster-statblock-section">
    <p className="monster-statblock-label"><strong>Заклинания</strong></p>
    <p className="monster-statblock-copy">{spellcasting.casting_mode === 'innate' ? 'Врождённое колдовство' : 'Колдовство'}{spellcasting.caster_level != null ? `, уровень заклинателя ${spellcasting.caster_level}` : ''}{spellcasting.class ? `, ${SPELL_CLASS_LABELS[spellcasting.class] ?? 'класс из источника'}` : ''}{spellcasting.ability ? `; характеристика: ${abilityLabel(spellcasting.ability)}` : ''}{spellcasting.save_dc != null ? `; СЛ ${spellcasting.save_dc}` : ''}{spellcasting.attack_modifier != null ? `; атака ${signed(spellcasting.attack_modifier)}` : ''}.</p>
    {components.length > 0 && <p className="monster-statblock-copy">Компоненты: {components.join(', ')}{without.length ? `; не требуются: ${without.join(', ')}` : ''}.</p>}
    {slots.length > 0 && <ul className="monster-statblock-list">{slots.map((slot, index) => <li key={`slot-${index}`}><strong>{slot.level === 0 ? 'Заговоры' : `${slot.level ?? '—'} круг`}</strong>{slot.slots != null ? ` — ячейки: ${slot.slots}` : ' — без ячеек'}{slot.spells?.length ? `: ${slot.spells.map((spell) => spell.name_ru || 'заклинание из каталога').join(', ')}` : ''}</li>)}</ul>}
    {innate.length > 0 && <ul className="monster-statblock-list">{innate.map((group, index) => <li key={`innate-${index}`}><strong>{formatUses(group.uses)}</strong>{group.spells?.length ? `: ${group.spells.map((spell) => spell.name_ru || 'заклинание из каталога').join(', ')}` : ''}</li>)}</ul>}
    {spellcasting.notes_ru && <p className="monster-statblock-copy">{spellcasting.notes_ru}</p>}
  </section>
}

function portraitSources(monster: MonsterCatalogEntry): string[] {
  const sources = monster.images?.length ? monster.images : monster.image ? [monster.image] : []
  return [...new Set(sources.filter((source): source is string => typeof source === 'string' && source.trim().length > 0))]
}

export function MonsterStatBlock({ monster }: { monster: MonsterCatalogEntry }) {
  const record = monster.statBlock ?? {}
  const [portraitIndex, setPortraitIndex] = useState(0)
  const images = portraitSources(monster)
  useEffect(() => setPortraitIndex(0), [monster.id])
  const imageIndex = Math.min(portraitIndex, Math.max(images.length - 1, 0))
  const name = record.name_ru || monster.name
  const sourceUrl = record.source_url || monster.sourceUrl
  const armorClass = record.armor_class?.value ?? monster.ac
  const hitPoints = record.hit_points?.average ?? monster.hp
  const challengeRating = record.challenge_rating ?? monster.cr
  const type = record.creature_type ? label(record.creature_type, CREATURE_TYPE_LABELS, 'тип из источника') : '—'
  const subtype = record.subtypes?.length ? ` (${record.subtypes.map((value) => SUBTYPE_LABELS[value] ?? 'особая разновидность').join(', ')})` : ''

  return <div className="monster-statblock">
    {images.length > 0 && <div className="monster-statblock-portrait-row">
      <img className="monster-statblock-portrait" src={images[imageIndex]} alt={`${name} — портрет ${imageIndex + 1}`} />
      {images.length > 1 && <label>Вариант портрета<select value={imageIndex} onChange={(event) => setPortraitIndex(Number(event.target.value))}>{images.map((_, index) => <option key={index} value={index}>Портрет {index + 1}</option>)}</select></label>}
    </div>}
    <p className="monster-statblock-name"><strong>{name}</strong>{record.name_en ? ` · ${record.name_en}` : ''}</p>
    <dl className="monster-statblock-overview">
      <div><dt>Тип и размер</dt><dd>{type}{subtype}, {label(record.size, SIZE_LABELS, 'размер из источника')}</dd></div>
      <div><dt>Мировоззрение</dt><dd>{label(record.alignment, ALIGNMENT_LABELS, 'не указано')}</dd></div>
      <div><dt>КД</dt><dd>{numberText(armorClass)}{record.armor_class?.details_ru ? ` (${record.armor_class.details_ru})` : ''}{record.armor_class?.alternatives?.length ? `; варианты: ${record.armor_class.alternatives.map((alternative) => `${numberText(alternative.value)} при особом условии`).join(', ')}` : ''}</dd></div>
      <div><dt>ОЗ</dt><dd>{numberText(hitPoints)}{record.hit_points?.formula ? ` (${dice(record.hit_points.formula)})` : ''}</dd></div>
      <div><dt>Опасность и опыт</dt><dd>{challengeRating} · {record.xp != null ? `${record.xp.toLocaleString('ru-RU')} опыта` : 'опыт не указан'}</dd></div>
      {record.proficiency_bonus != null && <div><dt>Бонус мастерства</dt><dd>{signed(record.proficiency_bonus)}</dd></div>}
      {record.initiative_bonus != null && <div><dt>Инициатива</dt><dd>{signed(record.initiative_bonus)}</dd></div>}
    </dl>

    <section className="monster-statblock-section">
      <p className="monster-statblock-label"><strong>Характеристики</strong></p>
      <table className="monster-statblock-table"><thead><tr><th>Характеристика</th><th>Значение</th><th>Модификатор</th></tr></thead><tbody>{ABILITY_KEYS.map((key) => {
        const score = record.abilities?.[key]
        const modifier = record.ability_modifiers?.[key]
        return <tr key={key}><th scope="row">{ABILITY_LABELS[key]}</th><td>{numberText(score)}</td><td>{modifier != null ? signed(modifier) : '—'}</td></tr>
      })}</tbody></table>
    </section>

    <dl className="monster-statblock-overview monster-statblock-details">
      <div><dt>Скорость</dt><dd>{formatSpeed(record.speed_ft)}</dd></div>
      <div><dt>Чувства</dt><dd>{formatSenses(record.senses)}</dd></div>
      <div><dt>Языки</dt><dd>{formatLanguages(record.languages)}</dd></div>
      <div><dt>Навыки</dt><dd>{record.skills && Object.keys(record.skills).length ? Object.entries(record.skills).map(([skill, bonus]) => `${SKILL_LABELS[skill] ?? 'Особый навык'} ${signed(bonus)}`).join(', ') : 'Отдельные навыки не указаны; используется базовый модификатор характеристики.'}</dd></div>
      <div><dt>Спасброски</dt><dd>{record.saving_throws && Object.keys(record.saving_throws).length ? Object.entries(record.saving_throws).map(([ability, bonus]) => `${abilityLabel(ability)} ${signed(bonus)}`).join(', ') : 'Отдельные спасброски не указаны; используется базовый модификатор характеристики.'}</dd></div>
      <div><dt>Сопротивления</dt><dd>{defenseList(record.damage_resistances)}</dd></div>
      <div><dt>Иммунитет к урону</dt><dd>{defenseList(record.damage_immunities)}</dd></div>
      <div><dt>Уязвимости</dt><dd>{defenseList(record.damage_vulnerabilities)}</dd></div>
      <div><dt>Иммунитет к состояниям</dt><dd>{conditionList(record.condition_immunities)}</dd></div>
    </dl>

    {record.lore?.summary_ru && <section className="monster-statblock-section"><p className="monster-statblock-label"><strong>Кратко</strong></p><p className="monster-statblock-copy">{record.lore.summary_ru}</p></section>}
    <FeatureSection title="Особенности" entries={record.traits} />
    <ActionSection title="Действия" actions={record.actions} />
    <ActionSection title="Бонусные действия" actions={record.bonus_actions} />
    <ActionSection title="Реакции" actions={record.reactions} />
    <ActionSection title="Легендарные действия" actions={record.legendary_actions} />
    <ActionSection title="Действия в логове" actions={record.lair_actions} />
    <SpellcastingSection spellcasting={record.spellcasting} />
    <section className="monster-statblock-source"><strong>Источник</strong>: {record.book_code || 'MM14'} · <a href={sourceUrl} target="_blank" rel="noreferrer">страница статблока на dnd.su</a></section>
  </div>
}
