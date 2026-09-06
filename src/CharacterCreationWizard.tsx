import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, ShieldCheck, Sparkles, X } from 'lucide-react'

import type {
  CharacterAbilityScores,
  CharacterCreationCatalog,
  MechanicsSupport,
  Player,
} from './types'
import { mechanicsSupportPresentation } from './tactical-ui'
import { SKILL_LABELS } from './app-shared'
import { CombatIcon } from './CombatIcon'
import './character-creation.css'
import { PhbCharacterOptions } from './PhbCharacterOptions'
import type { PhbCharacterOptionsValue } from './PhbCharacterOptions'
import { resolveCharacterCreationFeat } from '../server/character-creation-feats.mjs'
import { validateClassChoices } from '../server/character-creation-class-options.mjs'

/**
 * «Защита» (Defense) и «Оборона» (Protection) — разные боевые стили, но в
 * списке рядом читаются как один и тот же перевод. Названия приходят из
 * лицензированного каталога и не переписываются; различие даёт подпись.
 */
const FEATURE_HINTS: Record<string, string> = {
  'fighting-style-defense': '+1 к КД, пока носите доспех',
  'fighting-style-protection': 'реакцией мешаете атаке по союзнику рядом',
}

/**
 * Что навык делает за столом. Каталог даёт только имя и характеристику, а без
 * пояснения шаг выбора превращался в угадайку по названию.
 */
const SKILL_HINTS: Record<string, string> = {
  acrobatics: 'Удержать равновесие, вывернуться из захвата, мягко упасть.',
  'animal-handling': 'Успокоить зверя, править упряжкой, понять намерения животного.',
  arcana: 'Опознать заклинание, магический предмет или след ритуала.',
  athletics: 'Лезть, прыгать, плыть, толкать и удерживать в силовой борьбе.',
  deception: 'Соврать убедительно, выдать себя за другого, отвести подозрение.',
  history: 'Вспомнить события, династии, войны и происхождение реликвии.',
  insight: 'Понять, лжёт ли собеседник и чего он хочет на самом деле.',
  intimidation: 'Добиться своего угрозой, давлением или холодной уверенностью.',
  investigation: 'Найти улику, вычислить тайник, восстановить ход событий.',
  medicine: 'Стабилизировать умирающего, распознать болезнь или яд.',
  nature: 'Знать местность, погоду, растения и повадки зверей.',
  perception: 'Заметить спрятанное, услышать шорох, разглядеть засаду.',
  performance: 'Захватить публику песней, речью или представлением.',
  persuasion: 'Договориться по-доброму: убедить, расположить, примирить.',
  religion: 'Знать божеств, обряды, символы культов и нежить.',
  'sleight-of-hand': 'Незаметно взять, подменить или спрятать предмет. Замки открывают воровскими инструментами.',
  stealth: 'Двигаться бесшумно и оставаться незамеченным.',
  survival: 'Идти по следу, ориентироваться, добывать еду, читать погоду.',
}

const skillHintFor = (id: string) => SKILL_HINTS[String(id).toLowerCase().replace(/_/gu, '-')] ?? ''

/**
 * Эмблема класса. Карточки различались только текстом, из-за чего выбор
 * читался как список строк. Рисунки штриховые и берут цвет от карточки,
 * поэтому подчиняются состоянию «выбрано» и не тянут за собой растровые
 * ассеты с отдельными правами.
 */
const CLASS_EMBLEMS: Record<string, ReactNode> = {
  // Секира с двойным лезвием.
  barbarian: <><path d="M12 3v18" /><path d="M12 6c3-2 6-2 8 0-2 2-5 3-8 2Z" /><path d="M12 6c-3-2-6-2-8 0 2 2 5 3 8 2Z" /></>,
  // Лютня: корпус, гриф и колки.
  bard: <><ellipse cx="9" cy="16" rx="5" ry="5.5" /><circle cx="9" cy="16" r="1.6" /><path d="M12.5 12.5 18 6" /><path d="m17 4.5 2.5 2.5" /><path d="m19 3 2 2" /></>,
  // Храмовый символ: солнце над крестом.
  cleric: <><path d="M12 21V9" /><path d="M8 13h8" /><circle cx="12" cy="6" r="3" /><path d="M12 1v1.5M12 9.5V11M7 6H5.5M18.5 6H17" /></>,
  // Дубовый лист с прожилками.
  druid: <><path d="M12 21c0-8 4-14 9-16 1 8-3 15-9 16Z" /><path d="M12 21c-2-5-5-7-9-8 4-3 8-2 10 1" /><path d="M13 12.5 12 21" /></>,
  // Меч и щит.
  fighter: <><path d="M8 3v11l-2 2 3 3 3-3-2-2V3Z" /><path d="M16 5h5v6c0 4-2.5 6-5 7-2.5-1-5-3-5-7" /></>,
  // Кулак монаха.
  monk: <><path d="M7 11V7.5a1.5 1.5 0 0 1 3 0V11" /><path d="M10 10.5V6a1.5 1.5 0 0 1 3 0v4.5" /><path d="M13 10.5V7a1.5 1.5 0 0 1 3 0v6" /><path d="M16 11.5c0-1 2-1.5 2 .5v3c0 3-2.5 6-6 6s-6-2.5-6-6v-2c0-2 2-2 2 0" /></>,
  // Щит с восходящим солнцем клятвы.
  paladin: <><path d="M12 2 4 5v7c0 5.5 3.5 8.5 8 10 4.5-1.5 8-4.5 8-10V5Z" /><path d="M8 13a4 4 0 0 1 8 0" /><path d="M12 5.5V9" /></>,
  // Лук со стрелой.
  ranger: <><path d="M6 3c7 4 7 14 0 18" /><path d="M6 3 6 21" /><path d="M4 12h14" /><path d="m15 9 3 3-3 3" /></>,
  // Кинжал с каплей яда.
  rogue: <><path d="M12 2 9 9h6Z" /><path d="M12 9v9" /><path d="M9 12h6" /><path d="M12 22c1.2 0 2-.8 2-2 0-1.2-2-3-2-3s-2 1.8-2 3c0 1.2.8 2 2 2Z" /></>,
  // Родовая искра: пламя в ладони судьбы.
  sorcerer: <><path d="M12 2c2.5 4.5 6 6 6 10a6 6 0 0 1-12 0c0-4 3.5-5.5 6-10Z" /><path d="M12 18c-1.6 0-2.6-1-2.6-2.4 0-1.8 2.6-3.2 2.6-5.4" /></>,
  // Око покровителя в кольце пакта.
  warlock: <><path d="M2 12s4-6.5 10-6.5S22 12 22 12s-4 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="3.2" /><path d="M12 2v1.8M12 20.2V22M4 4l1.4 1.4M18.6 18.6 20 20" /></>,
  // Раскрытая книга заклинаний.
  wizard: <><path d="M3 5.5c3-1.5 6-1.5 9 0v14c-3-1.5-6-1.5-9 0Z" /><path d="M21 5.5c-3-1.5-6-1.5-9 0v14c3-1.5 6-1.5 9 0Z" /><path d="M12 5.5v14" /></>,
}

/**
 * Эмблемы служат запасным вариантом при ошибке загрузки портретов.
 * Авторские сгенерированные портреты и их промпты описаны в
 * docs/species-portrait-prompts.json; рисунки с dnd.su не используются.
 */
const SPECIES_EMBLEMS: Record<string, ReactNode> = {
  human: <><circle cx="12" cy="8" r="3.4" /><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" /></>,
  elf: <><circle cx="12" cy="9" r="3.2" /><path d="M6 20c0-3.6 2.7-6.4 6-6.4s6 2.8 6 6.4" /><path d="M8.8 7.2 5.5 4.6M15.2 7.2l3.3-2.6" /></>,
  dwarf: <><circle cx="12" cy="7.5" r="3" /><path d="M7 20v-3c0-2.2 2.2-4 5-4s5 1.8 5 4v3" /><path d="M9 12c.8 3 1.4 4.5 3 6 1.6-1.5 2.2-3 3-6" /></>,
  halfling: <><circle cx="12" cy="9.5" r="3" /><path d="M7 20c0-3 2.2-5.4 5-5.4s5 2.4 5 5.4" /><path d="M6 9.5c1.5-2 3.5-3 6-3s4.5 1 6 3" /></>,
  gnome: <><circle cx="12" cy="11" r="2.8" /><path d="M7.5 20c0-2.6 2-4.6 4.5-4.6s4.5 2 4.5 4.6" /><path d="M12 3 7 9h10Z" /></>,
  'half-orc': <><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20c0-3.7 2.9-6.6 6.5-6.6s6.5 2.9 6.5 6.6" /><path d="M9.5 10.5 9 12.5M14.5 10.5l.5 2" /></>,
  'half-elf': <><circle cx="12" cy="8.6" r="3.3" /><path d="M5.8 20c0-3.7 2.8-6.5 6.2-6.5s6.2 2.8 6.2 6.5" /><path d="M15.1 6.9 18 4.8" /></>,
  tiefling: <><circle cx="12" cy="10" r="3.2" /><path d="M6.5 20c0-3.2 2.5-5.6 5.5-5.6s5.5 2.4 5.5 5.6" /><path d="M8.6 7.4C7.4 5.6 7 4 7.2 2.8c1.6.5 2.9 1.7 3.6 3.2" /><path d="M15.4 7.4c1.2-1.8 1.6-3.4 1.4-4.6-1.6.5-2.9 1.7-3.6 3.2" /></>,
  dragonborn: <><path d="M12 4c3.4 0 6 2.2 6 5 0 3.6-2.6 6.4-6 8.6-3.4-2.2-6-5-6-8.6 0-2.8 2.6-5 6-5Z" /><path d="M9.6 9h.01M14.4 9h.01" /><path d="M6 6.5 3.4 4.4M18 6.5l2.6-2.1" /></>,
  custom: <><circle cx="12" cy="12" r="8.6" /><path d="M12 8v5" /><path d="M12 16h.01" /></>,
}

function SpeciesEmblem({ speciesId, label }: { speciesId: string; label: string }) {
  const [failed, setFailed] = useState(false)
  const glyph = SPECIES_EMBLEMS[speciesId]
  if (!failed) {
    return <span className="species-art">
      <img
        src={`/assets/species/${speciesId}.png`}
        alt=""
        aria-hidden="true"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  }
  return <span className="species-art">
    {glyph
      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: '100%', height: '100%', color: '#c8a06a', padding: 12 }}>{glyph}</svg>
      : <span>{label.slice(0, 2).toLocaleUpperCase('ru')}</span>}
  </span>
}

function ClassEmblem({ classId }: { classId: string }) {
  const [failed, setFailed] = useState(false)
  const glyph = CLASS_EMBLEMS[classId]
  return <span className="class-emblem" aria-hidden="true">
    {!failed
      ? <img src={`/assets/ui/class-icons/${classId}.webp`} alt="" loading="eager" decoding="async" onError={() => setFailed(true)} />
      : glyph
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{glyph}</svg>
        : null}
  </span>
}

/** Ведущая характеристика класса — куда случайный герой кладёт лучшее значение. */
const PRIMARY_ABILITY: Record<string, 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'> = {
  barbarian: 'str', bard: 'cha', cleric: 'wis', druid: 'wis', fighter: 'str', monk: 'dex',
  paladin: 'str', ranger: 'dex', rogue: 'dex', sorcerer: 'cha', warlock: 'cha', wizard: 'int',
}

const RANDOM_NAMES = [
  'Ална Верес', 'Борен Тихая Сталь', 'Виден Кром', 'Гелла Ржавый Ключ', 'Дарен Ольховый',
  'Ивета Соль', 'Кирем Двухпалый', 'Лисса Пепел', 'Мирон Заречный', 'Нэда Стужа',
  'Овен Крапива', 'Рута Мельник', 'Сван Долгий Шаг', 'Тайра Уголь', 'Фарн Оникс',
]

const RANDOM_BACKGROUNDS = [
  'солдат', 'учёная', 'странник', 'ремесленник', 'сирота с окраины', 'моряк',
  'послушник храма', 'охотник', 'торговец вразнос', 'бывший вор',
]

const abilityIds = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const
const abilityLabels: Record<(typeof abilityIds)[number], string> = {
  str: 'Сила',
  dex: 'Ловкость',
  con: 'Телосложение',
  int: 'Интеллект',
  wis: 'Мудрость',
  cha: 'Харизма',
}

type CreationDraft = {
  equipmentMode: 'standard' | 'wealth'
  purchases: Array<{ id: string; quantity: number }>
  purchaseId: string
  purchaseQuantity: number
  phb: PhbCharacterOptionsValue
  backgroundEquipmentChoices: Record<string, string[]>
  backgroundReplacementTools: string[]
  customBackground: boolean
  customBackgroundName: string
  customBackgroundSkills: string[]
  customToolCount: number
  customFeatureBackground: string
  customVariant: string
  alignment: string
  ideals: string
  bonds: string
  flaws: string
  abilityMethod: 'standard_array' | 'point_buy' | 'rolled'
  classId: string
  subclass: string
  speciesOptionId: string
  /** Дополнительные +1 вида, например две характеристики полуэльфа. */
  speciesBonusAbilities: string[]
  speciesChoices: Record<string, string[]>
  customSpecies: string
  background: string
  backgroundId: string
  /** Раскладка прибавок предыстории: `two_one` либо `one_one_one`. */
  backgroundAbilityMode: string
  /** Порядок нажатия задаёт размер прибавки: первая получает больше. */
  backgroundAbilities: string[]
  backgroundTools: string[]
  backgroundLanguages: string[]
  backgroundReplacementSkills: string[]
  starterEquipmentChoices: Record<string, string[]>
  abilities: CharacterAbilityScores
  classSkillIds: string[]
  selectedFeatureIds: string[]
  knownSpellIds: string[]
  preparedSpellIds: string[]
  character: string
  appearance: string
  backstory: string
}

const emptyScores = (): CharacterAbilityScores => ({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 })
const zeroScores = (): CharacterAbilityScores => ({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 })
const defaultChoiceRecord = (groups: Array<{ id: string; count: number; options: Array<{ id: string }> }> = []) => Object.fromEntries(
  groups.map((group) => [group.id, group.options.slice(0, group.count).map((option) => option.id)]),
)

function initialDraft(catalog: CharacterCreationCatalog): CreationDraft {
  const assigned = emptyScores()
  abilityIds.forEach((ability, index) => { assigned[ability] = catalog.ability_policy.standard_array[index] ?? 10 })
  const initialSpecies = catalog.ability_policy.species_options[0]
  const initialClass = catalog.classes[0]
  return {
    abilityMethod: 'standard_array',
    equipmentMode: 'standard', purchases: [], purchaseId: '', purchaseQuantity: 1,
    phb: { schema_version: 1, classChoices: {} },
    backgroundEquipmentChoices: {}, backgroundReplacementTools: [],
    customBackground: false, customBackgroundName: '', customBackgroundSkills: [], customToolCount: 0, customFeatureBackground: '', customVariant: '',
    alignment: '', ideals: '', bonds: '', flaws: '',
    classId: initialClass?.id ?? '',
    subclass: '',
    speciesOptionId: initialSpecies?.id ?? '',
    speciesBonusAbilities: [],
    speciesChoices: defaultChoiceRecord(initialSpecies?.choice_groups),
    customSpecies: '',
    background: '',
    backgroundId: '',
    backgroundAbilityMode: 'two_one',
    backgroundAbilities: [],
    backgroundTools: [],
    backgroundLanguages: [],
    backgroundReplacementSkills: [],
    starterEquipmentChoices: defaultChoiceRecord(initialClass?.starter_equipment?.choice_groups),
    abilities: assigned,
    classSkillIds: [],
    selectedFeatureIds: [],
    knownSpellIds: [],
    preparedSpellIds: [],
    character: '',
    appearance: '',
    backstory: '',
  }
}

/**
 * Русский счёт: 1 заговор, 2 заговора, 5 заговоров. Раньше подсказки склеивали
 * число с одной формой — «Выберите 3 заговоров», — и текст выдавал шаблон.
 */
function plural(count: number, forms: [string, string, string]) {
  const tail = Math.abs(count) % 100
  const last = tail % 10
  if (tail > 10 && tail < 20) return forms[2]
  if (last === 1) return forms[0]
  if (last > 1 && last < 5) return forms[1]
  return forms[2]
}

function abilityModifier(score: number) {
  return Math.floor((score - 10) / 2)
}

/**
 * Общий статус механики для списка — или `null`, если статусы разные.
 *
 * Статус обязан быть виден игроку (`AGENTS.md`, словарь статусов), но когда он
 * одинаков у всех до единого заклинаний, ярлык в каждой карточке перестаёт
 * что-либо различать и превращается в шум: список из тридцати «ЧАСТИЧНО» не
 * несёт информации. Одинаковый статус выносим строкой над списком, разный
 * оставляем на карточках — там он и правда различает.
 */
function sharedSupport(spells: Array<{ mechanics_support?: MechanicsSupport | null }>) {
  if (spells.length < 2) return null
  const first = mechanicsSupportPresentation(spells[0].mechanics_support ?? undefined)
  const same = spells.every((spell) => mechanicsSupportPresentation(spell.mechanics_support ?? undefined).status === first.status)
  return same ? first : null
}

function signed(value: number) {
  return value >= 0 ? `+${value}` : String(value)
}

export function CharacterCreationWizard({
  player,
  accountName,
  catalog,
  rulesetId,
  required = false,
  onClose,
  onImport,
  onRollAbilities,
  onRollWealth,
}: {
  player: Player
  accountName: string
  catalog: CharacterCreationCatalog
  rulesetId?: string
  required?: boolean
  onClose: () => void
  onImport: (source: string) => Promise<void>
  onRollAbilities?: () => Promise<void>
  onRollWealth?: (classId: string) => Promise<void>
}) {
  const [step, setStep] = useState(0)
  const [furthestStep, setFurthestStep] = useState(0)
  const [draft, setDraft] = useState<CreationDraft>(() => initialDraft(catalog))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // `hero-slot-3` — внутренний идентификатор, игроку он ничего не говорит.
  const slotLabel = /^hero-slot-(\d+)$/.test(player.id)
    ? `место ${player.id.replace('hero-slot-', '')} из отряда`
    : player.character || player.id
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  const [spellSearch, setSpellSearch] = useState('')
  const classOption = catalog.classes.find((entry) => entry.id === draft.classId) ?? catalog.classes[0]
  const speciesOption = catalog.ability_policy.species_options.find((entry) => entry.id === draft.speciesOptionId)
  const abilityRoll = player.characterCreationRolls?.abilities
  const wealthRoll = player.characterCreationRolls?.wealth
  const purchaseTotal = draft.purchases.reduce((sum, item) => sum + item.quantity * (catalog.starting_wealth?.items.find((entry) => entry.id === item.id)?.price_cp ?? 0), 0)
  const abilityValues = draft.abilityMethod === 'rolled' ? abilityRoll?.scores ?? [] : catalog.ability_policy.standard_array
  const abilityChoices = draft.abilityMethod === 'point_buy' ? [8, 9, 10, 11, 12, 13, 14, 15] : [...new Set(abilityValues)].sort((a, b) => b - a)
  const pointBuySpent = abilityIds.reduce((sum, ability) => sum + (catalog.point_buy?.costs[draft.abilities[ability]] ?? 0), 0)
  useEffect(() => {
    if (draft.abilityMethod === 'rolled' && abilityRoll?.scores.length === 6) {
      setDraft((current) => ({ ...current, abilities: Object.fromEntries(abilityIds.map((id, index) => [id, abilityRoll.scores[index]])) as CharacterAbilityScores }))
    }
  }, [draft.abilityMethod, abilityRoll?.id])
  const skillRule = classOption?.class_skills
  const featureGroups = classOption?.feature_choice_groups ?? []
  const spellRules = classOption?.spell_selection
  // Неисполнимые карточки не предлагаются к выбору, поэтому и лимиты считаем
  // от того, что реально можно взять: иначе класс с бедным каталогом запер бы
  // мастер на недостижимом «выберите 3 заговора».
  const selectable = (spell: { mechanics_support?: MechanicsSupport | null }) => Boolean(catalog.phb) || !mechanicsSupportPresentation(spell.mechanics_support ?? undefined).blocked
  // Поиск по названию и описанию: у полного класса список 1 круга уходит за
  // экран, и найти нужное заклинание глазами было нельзя. Уже выбранные
  // карточки остаются видимыми при любом запросе — иначе счётчик показывает
  // «2/3», а что именно взято, не видно.
  const cantrips = spellRules?.spells.filter((spell) => spell.level === 0 && selectable(spell)) ?? []
  const magicSubclass = catalog.phb?.classes.find((entry) => entry.id === draft.classId)?.subclass_options?.find((entry) => entry.label === draft.subclass || entry.id === draft.subclass)
  const expandedSpells = (magicSubclass?.expanded_spell_list as Record<number, string[]> | undefined)?.[1] ?? []
  const canonicalSpellId = (id: string) => id === 'tashas_hideous_laughter' ? 'tasha-s-hideous-laughter' : id.replaceAll('_', '-')
  const domainSpellIds = ((magicSubclass?.domain_spells as Record<number, string[]> | undefined)?.[1] ?? []).map(canonicalSpellId)
  const leveledSpells = [...(spellRules?.spells.filter((spell) => spell.level === 1 && selectable(spell)) ?? []),
    ...(catalog.phb?.spells ?? []).filter((spell) => expandedSpells.map(canonicalSpellId).includes(spell.id) && !spellRules?.spells.some((base) => base.id === spell.id)).map((spell) => ({
      id: spell.id, name: spell.name ?? spell.id, level: spell.level, description: String(spell.description ?? ''), casting_time: String(spell.casting_time ?? ''), range_text: String(spell.range_text ?? ''), mechanics_support: spell.mechanics_support as MechanicsSupport,
    })),
  ]
  // Поиск по названию и описанию: у полного класса список 1 круга уходит за
  // экран, и найти нужное заклинание глазами было нельзя. Фильтр действует
  // только на показ — лимиты и счётчики выше считаются по полному списку,
  // иначе запрос молча менял бы условие «выберите 3 заговора». Уже выбранные
  // карточки остаются видимыми при любом запросе.
  const spellQuery = spellSearch.trim().toLocaleLowerCase('ru')
  const matchesQuery = (spell: { id: string; name: string; description?: string }) => !spellQuery
    || draft.knownSpellIds.includes(spell.id)
    || `${spell.name} ${spell.description ?? ''}`.toLocaleLowerCase('ru').includes(spellQuery)
  const visibleCantrips = cantrips.filter(matchesQuery)
  const visibleLeveledSpells = leveledSpells.filter(matchesQuery)
  const selectedCantrips = cantrips.filter((spell) => draft.knownSpellIds.includes(spell.id)).length
  const selectedKnownSpells = leveledSpells.filter((spell) => draft.knownSpellIds.includes(spell.id)).length
  const selectedPreparedSpells = leveledSpells.filter((spell) => draft.preparedSpellIds.includes(spell.id)).length
  const selectedSpecies = speciesOption?.id === 'custom' ? draft.customSpecies.trim() : speciesOption?.label ?? ''
  const cantripLimit = Math.min(spellRules?.cantrips ?? 0, cantrips.length)
  const knownLimit = Math.min(spellRules?.spellsKnown ?? 0, leveledSpells.length)
  const bookLimit = Math.min(spellRules?.spellbookMinimum ?? 0, leveledSpells.length)
  const cantripSupport = sharedSupport(cantrips)
  const leveledSupport = sharedSupport(leveledSpells)

  const steps = useMemo(() => [
    { title: 'Класс', description: 'Двенадцать классов на выбор' },
    { title: 'Раса', description: 'Раса, подраса и наследие' },
    { title: 'Предыстория', description: 'Опыт до приключения' },
    { title: 'Характеристики', description: 'Стандартный массив' },
    { title: 'Владения', description: 'Навыки и расовые выборы' },
    { title: 'Снаряжение', description: 'Стартовый комплект' },
    { title: 'Магия', description: 'Заговоры и 1 круг' },
    { title: 'Личность', description: 'Имя и история' },
  ], [])

  const patch = <K extends keyof CreationDraft>(key: K, value: CreationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setError('')
  }

  const backgroundOptions = catalog.backgrounds?.options ?? []
  const abilityModes = catalog.backgrounds?.ability_modes ?? []
  const bonusSource = catalog.ability_policy.bonus_source
  const baseBackground = backgroundOptions.find((option) => option.id === draft.backgroundId) ?? null
  const selectedBackground = baseBackground && draft.customBackground ? {
    ...baseBackground, name: draft.customBackgroundName || 'Своя предыстория', skillProficiencies: draft.customBackgroundSkills,
    toolProficiencies: [], toolChoice: { group: 'custom', count: draft.customToolCount, options: catalog.backgrounds?.customization?.tool_options ?? [] },
    languageChoiceCount: 2 - draft.customToolCount,
    feature: backgroundOptions.find((entry) => entry.id === draft.customFeatureBackground)?.feature,
  } : baseBackground
  const speciesBonusProfile = catalog.ability_policy.origin_bonus_profiles.find((profile) => profile.id === speciesOption?.bonus_profile_id)
  const speciesChoiceGroups = speciesOption?.choice_groups ?? []
  const speciesLanguages = new Set([
    ...(speciesOption?.languages ?? []),
    ...speciesChoiceGroups.filter((group) => group.kind === 'language').flatMap((group) => draft.speciesChoices[group.id] ?? []),
  ])
  const allSkills = [...new Map(catalog.classes.flatMap((entry) => entry.class_skills?.options ?? []).map((skill) => [skill.id, skill])).values()]
  const speciesFixedSkills = Array.isArray(speciesOption?.mechanics?.skill_proficiencies) ? speciesOption.mechanics.skill_proficiencies.map(String) : []
  const grantedSkills = [
    ...draft.classSkillIds, ...speciesFixedSkills,
    ...speciesChoiceGroups.filter((group) => group.kind === 'skill').flatMap((group) => draft.speciesChoices[group.id] ?? []),
    ...(selectedBackground?.skillProficiencies ?? []),
    ...(Array.isArray(draft.phb.classChoices.knowledge_skills) ? draft.phb.classChoices.knowledge_skills.map(String) : []),
    ...(draft.phb.classChoices.nature_skill ? [String(draft.phb.classChoices.nature_skill)] : []),
    ...(draft.phb.feat?.id === 'skilled' && Array.isArray(draft.phb.feat.choices.skills) ? draft.phb.feat.choices.skills.map(String) : []),
  ].map((id) => id.replaceAll('-', '_'))
  const knownSkills = new Set(grantedSkills)
  const replacementCount = catalog.ruleset_id === 'dnd_5e_2014' ? grantedSkills.length - knownSkills.size : 0
  const replacementSkills = draft.backgroundReplacementSkills.filter((id) => !knownSkills.has(id)).slice(0, replacementCount)
  const duplicateBackgroundLanguage = draft.backgroundLanguages.some((id) => speciesLanguages.has(id))
  const phbClass = catalog.phb?.classes.find((entry) => entry.id === draft.classId)
  const arrayStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
  const toolKey = (id: string) => ({ dragonchess_set: 'dragonchess', three_dragon_ante_set: 'three_dragon_ante', playing_card_set: 'playing_cards', land_vehicles: 'vehicles_land', water_vehicles: 'vehicles_water' } as Record<string, string>)[id] ?? id
  const grantedTools = [
    ...arrayStrings(speciesOption?.mechanics?.tool_proficiencies),
    ...speciesChoiceGroups.filter((group) => group.kind === 'tool').flatMap((group) => draft.speciesChoices[group.id] ?? []),
    ...(selectedBackground?.toolProficiencies ?? []).map((entry) => entry.id), ...draft.backgroundTools,
    ...(phbClass?.tool_proficiencies ?? []), ...arrayStrings(draft.phb.classChoices.instruments),
    ...(draft.phb.classChoices.tool_or_instrument && typeof draft.phb.classChoices.tool_or_instrument === 'object' ? [String((draft.phb.classChoices.tool_or_instrument as { id: string }).id)] : []),
    ...(draft.phb.feat?.id === 'skilled' ? arrayStrings(draft.phb.feat.choices.tools) : []),
  ].map(toolKey)
  const knownTools = new Set(grantedTools)
  const replacementToolCount = catalog.phb ? grantedTools.length - knownTools.size : 0
  const replacementTools = draft.backgroundReplacementTools.filter((id) => !knownTools.has(id)).slice(0, replacementToolCount)
  const speciesChoicesReady = speciesChoiceGroups.every((group) => (draft.speciesChoices[group.id] ?? []).length === group.count)
  const speciesChoiceCount = speciesBonusProfile?.choice_count ?? 0
  const speciesChoiceAmount = speciesBonusProfile?.choice_amount ?? 0
  const speciesChoiceOptions = abilityIds.filter((ability) => !(speciesBonusProfile?.excluded_choices ?? []).includes(ability))
  const originIncreases = abilityModes.find((mode) => mode.id === draft.backgroundAbilityMode)?.increases ?? []
  const originBonusReady = bonusSource === 'species'
    ? Boolean(speciesOption && speciesBonusProfile) && draft.speciesBonusAbilities.length === speciesChoiceCount
    : Boolean(selectedBackground) && draft.backgroundAbilities.length === originIncreases.length
  const toolChoiceCount = selectedBackground?.toolChoice?.count ?? 0
  const languageChoiceCount = selectedBackground?.languageChoiceCount ?? 0
  const backgroundChoicesReady = Boolean(selectedBackground)
    && draft.backgroundTools.length === toolChoiceCount
    && draft.backgroundLanguages.length === languageChoiceCount
  const starterProfile = classOption?.starter_equipment ?? null
  const starterGroups = starterProfile?.choice_groups ?? []
  const starterChoicesReady = starterGroups.every((group) => (draft.starterEquipmentChoices[group.id] ?? []).length === group.count)
  const skillNameFor = (id: string) => SKILL_LABELS[String(id)] ?? String(id)
  const abilityBonusLabel = (profile = speciesBonusProfile) => {
    if (!profile) return 'без прибавок'
    const fixed = abilityIds
      .filter((ability) => Number(profile.fixed_bonuses?.[ability] ?? 0) > 0)
      .map((ability) => `+${profile.fixed_bonuses?.[ability]} ${abilityLabels[ability]}`)
    const choiceCount = profile.choice_count ?? 0
    if (choiceCount > 0) fixed.push(`+${profile.choice_amount ?? 0} к ${choiceCount} на выбор`)
    return fixed.join(', ') || profile.label
  }
  const originBonuses = zeroScores()
  if (bonusSource === 'species') {
    for (const ability of abilityIds) originBonuses[ability] = speciesBonusProfile?.fixed_bonuses?.[ability] ?? 0
    for (const ability of draft.speciesBonusAbilities) originBonuses[ability as keyof CharacterAbilityScores] += speciesChoiceAmount
  } else {
    draft.backgroundAbilities.forEach((ability, index) => {
      originBonuses[ability as keyof CharacterAbilityScores] = originIncreases[index] ?? 0
    })
  }
  const preFeatAbilities = Object.fromEntries(abilityIds.map((ability) => [ability, Math.max(1, draft.abilities[ability] + originBonuses[ability])])) as CharacterAbilityScores
  const featPreview = speciesOption?.id === 'human-variant' && draft.phb.feat ? resolveCharacterCreationFeat(draft.phb.feat.id, draft.phb.feat.choices, {
    abilities: preFeatAbilities, armor: phbClass?.armor_proficiencies ?? [], weapons: phbClass?.weapon_proficiencies ?? [],
    skills: [...knownSkills, ...replacementSkills], tools: [...knownTools, ...replacementTools], languages: [...speciesLanguages, ...draft.backgroundLanguages],
    canCastSpells: ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard'].includes(draft.classId),
  }) : null
  const featBonuses = featPreview?.ok ? featPreview.benefits?.ability_increases ?? {} : {}
  const originBonusFor = (ability: string) => (originBonuses[ability as keyof CharacterAbilityScores] ?? 0) + (featBonuses[ability] ?? 0)
  const castingAbility = spellRules?.spellcastingAbility
  const preparedLimit = Math.min(leveledSpells.length, castingAbility && (spellRules.mode === 'prepared' || spellRules.mode === 'spellbook')
    ? Math.max(1, 1 + abilityModifier(draft.abilities[castingAbility] + originBonusFor(castingAbility))) : 0)
  const styleIds: Record<string, string> = { 'fighting-style-defense': 'defense', 'fighting-style-dueling': 'dueling', 'fighting-style-great-weapon': 'great_weapon_fighting', 'fighting-style-protection': 'protection', 'fighting-style-two-weapon': 'two_weapon_fighting', 'fighting-style-archery': 'archery' }
  const classPreview = catalog.phb ? validateClassChoices(draft.classId, {
    ...draft.phb.classChoices, skills: draft.classSkillIds, ...(draft.subclass ? { subclass: draft.subclass } : {}),
    ...(draft.classId === 'fighter' ? { fighting_style: styleIds[draft.selectedFeatureIds[0]] } : {}),
  }, { skill_proficiencies: [...knownSkills, ...replacementSkills], tool_proficiencies: [...knownTools, ...replacementTools] }) : null

  const selectSpecies = (option: (typeof catalog.ability_policy.species_options)[number]) => {
    const profile = catalog.ability_policy.origin_bonus_profiles.find((entry) => entry.id === option.bonus_profile_id)
    const excluded = new Set(profile?.excluded_choices ?? [])
    const choices = abilityIds.filter((ability) => !excluded.has(ability)).slice(0, profile?.choice_count ?? 0)
    setDraft((current) => ({
      ...current,
      speciesOptionId: option.id,
      phb: { schema_version: 1, classChoices: current.phb.classChoices, ...(option.id === 'human-variant' && current.phb.feat ? { feat: current.phb.feat } : {}) },
      customSpecies: '',
      speciesBonusAbilities: choices,
      speciesChoices: defaultChoiceRecord(option.choice_groups),
    }))
    setError('')
  }

  const selectBackground = (option: (typeof backgroundOptions)[number]) => {
    setDraft((current) => ({
      ...current,
      backgroundId: option.id,
      customBackground: false,
      backgroundEquipmentChoices: defaultChoiceRecord(catalog.starter_equipment?.backgrounds?.find((entry) => entry.background_id === option.id)?.choice_groups),
      background: option.name,
      // Раскладка по умолчанию — +2 первой из предложенных и +1 второй; её
      // можно переставить, но валидный выбор есть сразу.
      backgroundAbilityMode: 'two_one',
      backgroundAbilities: option.abilityOptions.slice(0, 2),
      backgroundTools: (option.toolChoice?.options ?? []).slice(0, option.toolChoice?.count ?? 0).map((entry) => entry.id),
      backgroundLanguages: (catalog.backgrounds?.language_options ?? []).filter((entry) => !speciesLanguages.has(entry.id)).slice(0, option.languageChoiceCount ?? 0).map((entry) => entry.id),
      backgroundReplacementSkills: [],
    }))
    setError('')
  }

  const setAbilityMode = (mode: string) => {
    const size = abilityModes.find((entry) => entry.id === mode)?.increases.length ?? 2
    setDraft((current) => ({
      ...current,
      backgroundAbilityMode: mode,
      backgroundAbilities: current.backgroundAbilities.slice(0, size),
    }))
    setError('')
  }

  /** Порядок нажатия задаёт, какая характеристика получит большую прибавку. */
  const toggleOriginAbility = (ability: string) => {
    setDraft((current) => {
      const size = abilityModes.find((entry) => entry.id === current.backgroundAbilityMode)?.increases.length ?? 2
      const already = current.backgroundAbilities.includes(ability)
      const next = already
        ? current.backgroundAbilities.filter((entry) => entry !== ability)
        : [...current.backgroundAbilities, ability].slice(-size)
      return { ...current, backgroundAbilities: next }
    })
    setError('')
  }

  const toggleSpeciesAbility = (ability: string) => {
    setDraft((current) => {
      const already = current.speciesBonusAbilities.includes(ability)
      const next = already
        ? current.speciesBonusAbilities.filter((entry) => entry !== ability)
        : [...current.speciesBonusAbilities, ability].slice(-speciesChoiceCount)
      return { ...current, speciesBonusAbilities: next }
    })
    setError('')
  }

  const toggleBackgroundChoice = (field: 'backgroundTools' | 'backgroundLanguages', id: string, maximum: number) => {
    setDraft((current) => {
      const selected = current[field]
      const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id].slice(-maximum)
      return { ...current, [field]: next }
    })
    setError('')
  }

  const toggleCatalogChoice = (
    field: 'speciesChoices' | 'starterEquipmentChoices',
    groupId: string,
    id: string,
    maximum: number,
  ) => {
    setDraft((current) => {
      const selected = current[field][groupId] ?? []
      const next = selected.includes(id)
        ? selected.filter((entry) => entry !== id)
        : [...selected, id].slice(-maximum)
      return { ...current, [field]: { ...current[field], [groupId]: next } }
    })
    setError('')
  }

  /**
   * Готовый герой одним нажатием. Собирается по тем же правилам каталога, что
   * и ручной путь: число классовых навыков, полнота групп умений и лимиты
   * заговоров и заклинаний берутся из `catalog`, поэтому результат проходит
   * `validateStep` на каждом шаге и его можно отправлять сразу.
   */
  const rollRandomHero = () => {
    const pick = <T,>(list: readonly T[]): T | undefined => (list.length ? list[Math.floor(Math.random() * list.length)] : undefined)
    const pickMany = <T,>(list: readonly T[], count: number): T[] => {
      const pool = [...list]
      const taken: T[] = []
      while (taken.length < count && pool.length) taken.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
      return taken
    }
    const rolledBackground = pick(backgroundOptions)
    const entry = pick(catalog.classes)
    if (!entry) return
    // Авторский вид требует ручного названия — случайному герою он не подходит.
    const species = pick(catalog.ability_policy.species_options.filter((option) => option.id !== 'custom'))
      ?? catalog.ability_policy.species_options[0]
    const rolledSpeciesProfile = catalog.ability_policy.origin_bonus_profiles.find((profile) => profile.id === species?.bonus_profile_id)
    const rolledSpeciesAbilities = pickMany(
      abilityIds.filter((ability) => !(rolledSpeciesProfile?.excluded_choices ?? []).includes(ability)),
      rolledSpeciesProfile?.choice_count ?? 0,
    )
    // Лучшее значение уходит в ведущую характеристику класса, второе — в
    // Телосложение: случайная раскладка регулярно давала мага с Силой 15.
    const primary = PRIMARY_ABILITY[entry.id] ?? 'str'
    const rest = pickMany(abilityIds.filter((ability) => ability !== primary && ability !== 'con'), 4)
    const order = [primary, 'con' as const, ...rest]
    const scores = [...catalog.ability_policy.standard_array].sort((left, right) => right - left)
    const abilities = { ...draft.abilities }
    order.forEach((ability, index) => { abilities[ability] = scores[index] ?? scores[scores.length - 1] })

    const rolledSkills = pickMany(entry.class_skills?.options ?? [], entry.class_skills?.choice_count ?? 0)
    const rolledFeatures = (entry.feature_choice_groups ?? [])
      .flatMap((group) => pickMany(group.options, group.choiceCount))
    const rolledSubclass = entry.subclass_level === 1 ? (entry.id === 'cleric' ? 'Домен жизни' : entry.subclasses[0]?.name ?? '') : ''
    const rolledClassChoices: Record<string, unknown> = entry.id === 'bard' ? { instruments: ['lute', 'drum', 'flute'] }
      : entry.id === 'monk' ? { tool_or_instrument: { kind: 'artisan_tool', id: 'smiths_tools' } }
        : entry.id === 'rogue' ? { expertise: rolledSkills.slice(0, 2).map((skill) => skill.id) }
          : entry.id === 'ranger' ? { favored_enemy: { type: 'undead', language: null }, natural_explorer: 'forest' }
            : entry.id === 'sorcerer' ? { draconic_ancestry: 'red' } : {}
    const rolledBackgroundTools = pickMany(rolledBackground?.toolChoice?.options ?? [], rolledBackground?.toolChoice?.count ?? 0).map((tool) => tool.id)
    const rolledSpeciesChoices = defaultChoiceRecord(species?.choice_groups)
    const rolledTools = [
      ...(catalog.phb?.classes.find((klass) => klass.id === entry.id)?.tool_proficiencies ?? []),
      ...arrayStrings(rolledClassChoices.instruments), ...(entry.id === 'monk' ? ['smiths_tools'] : []),
      ...arrayStrings(species?.mechanics?.tool_proficiencies), ...(species?.choice_groups ?? []).filter((group) => group.kind === 'tool').flatMap((group) => rolledSpeciesChoices[group.id] ?? []),
      ...(rolledBackground?.toolProficiencies ?? []).map((tool) => tool.id), ...rolledBackgroundTools,
    ].map(toolKey)
    const rolledToolSet = new Set(rolledTools)
    const rolledLanguages = new Set([...(species?.languages ?? []), ...(species?.choice_groups ?? []).filter((group) => group.kind === 'language').flatMap((group) => rolledSpeciesChoices[group.id] ?? [])])
    const rolledGrantedSkills = [
      ...rolledSkills.map((skill) => skill.id),
      ...(Array.isArray(species?.mechanics?.skill_proficiencies) ? species.mechanics.skill_proficiencies.map(String) : []),
      ...(species?.choice_groups ?? []).filter((group) => group.kind === 'skill').flatMap((group) => rolledSpeciesChoices[group.id] ?? []),
      ...(rolledBackground?.skillProficiencies ?? []),
    ].map((id) => id.replaceAll('-', '_'))
    const rolledKnownSkills = new Set(rolledGrantedSkills)
    const rolledSpells = entry.spell_selection
      ? (() => {
          const usable = entry.spell_selection.spells.filter(selectable)
          const zero = usable.filter((spell) => spell.level === 0)
          const first = usable.filter((spell) => spell.level === 1)
          const known = [
            ...pickMany(zero, Math.min(entry.spell_selection.cantrips ?? 0, zero.length)),
            ...pickMany(first, Math.min(
              entry.spell_selection.mode === 'spellbook'
                ? entry.spell_selection.spellbookMinimum ?? 0
                : entry.spell_selection.mode === 'known'
                  ? entry.spell_selection.spellsKnown ?? 0
                  : entry.spell_selection.preparedLimit ?? 0,
              first.length,
            )),
          ]
          const prepared = entry.spell_selection.mode === 'prepared'
            ? known.filter((spell) => spell.level === 1).map((spell) => spell.id)
            : []
          return { knownSpellIds: known.map((spell) => spell.id), preparedSpellIds: prepared }
        })()
      : { knownSpellIds: [], preparedSpellIds: [] }

    setDraft((current) => ({
      ...current,
      classId: entry.id,
      abilityMethod: 'standard_array',
      subclass: rolledSubclass,
      phb: { schema_version: 1, classChoices: rolledClassChoices, ...(species?.id === 'human-variant' ? { feat: { id: 'tough', choices: {} } } : {}) },
      equipmentMode: 'standard', purchases: [], customBackground: false,
      backgroundEquipmentChoices: defaultChoiceRecord(catalog.starter_equipment?.backgrounds?.find((background) => background.background_id === rolledBackground?.id)?.choice_groups),
      backgroundReplacementTools: (catalog.phb?.tools ?? []).filter((tool) => !rolledToolSet.has(tool.id)).slice(0, rolledTools.length - rolledToolSet.size).map((tool) => tool.id),
      speciesOptionId: species?.id ?? current.speciesOptionId,
      speciesBonusAbilities: rolledSpeciesAbilities,
      speciesChoices: rolledSpeciesChoices,
      backgroundReplacementSkills: catalog.ruleset_id === 'dnd_5e_2014'
        ? pickMany(allSkills.filter((skill) => !rolledKnownSkills.has(skill.id)), rolledGrantedSkills.length - rolledKnownSkills.size).map((skill) => skill.id)
        : [],
      customSpecies: '',
      ...(rolledBackground ? {
        backgroundId: rolledBackground.id,
        background: rolledBackground.name,
        backgroundAbilityMode: abilityModes[0]?.id ?? 'none',
        backgroundAbilities: rolledBackground.abilityOptions.slice(0, abilityModes[0]?.increases.length ?? 0),
        backgroundTools: rolledBackgroundTools,
        backgroundLanguages: pickMany((catalog.backgrounds?.language_options ?? []).filter((language) => !rolledLanguages.has(language.id)), rolledBackground.languageChoiceCount ?? 0).map((language) => language.id),
      } : { background: pick(RANDOM_BACKGROUNDS) ?? 'странник' }),
      abilities,
      starterEquipmentChoices: defaultChoiceRecord(entry.starter_equipment?.choice_groups),
      classSkillIds: rolledSkills.map((skill) => skill.id),
      selectedFeatureIds: rolledFeatures.map((option) => option.id),
      ...rolledSpells,
      character: pick(RANDOM_NAMES) ?? 'Безымянный герой',
    }))
    setError('')
  }

  const selectClass = (classId: string) => {
    setDraft((current) => ({
      ...current,
      classId,
      phb: { ...current.phb, classChoices: {} },
      subclass: '',
      classSkillIds: [],
      selectedFeatureIds: [],
      knownSpellIds: [],
      preparedSpellIds: [],
      starterEquipmentChoices: defaultChoiceRecord(catalog.classes.find((entry) => entry.id === classId)?.starter_equipment?.choice_groups),
    }))
    setError('')
  }

  const assignAbility = (ability: keyof CharacterAbilityScores, score: number) => {
    setError('')
    setDraft((current) => {
      if (current.abilityMethod !== 'point_buy' && score !== 0 && (!abilityValues.includes(score)
        || abilityIds.filter((candidate) => candidate !== ability && current.abilities[candidate] === score).length >= abilityValues.filter((value) => value === score).length)) return current
      return { ...current, abilities: { ...current.abilities, [ability]: score } }
    })
  }

  const toggleBounded = (values: string[], id: string, maximum: number) => {
    if (values.includes(id)) return values.filter((value) => value !== id)
    return values.length < maximum ? [...values, id] : values
  }

  const toggleSkill = (id: string) => {
    if (!skillRule) return
    const next = toggleBounded(draft.classSkillIds, id, skillRule.choice_count)
    if (next === draft.classSkillIds) setError(`Можно выбрать ${skillRule.choice_count} ${plural(skillRule.choice_count, ['навык', 'навыка', 'навыков'])}.`)
    else patch('classSkillIds', next)
  }

  const toggleFeature = (group: (typeof featureGroups)[number], id: string) => {
    const groupIds = new Set(group.options.map((option) => option.id))
    const other = draft.selectedFeatureIds.filter((value) => !groupIds.has(value))
    const selected = draft.selectedFeatureIds.filter((value) => groupIds.has(value))
    const next = toggleBounded(selected, id, group.choiceCount)
    if (next === selected) setError(`${group.name}: можно выбрать ${group.choiceCount}.`)
    else patch('selectedFeatureIds', [...other, ...next])
  }

  const toggleSpell = (id: string, prepare = false) => {
    if (!spellRules) return
    const spell = spellRules.spells.find((entry) => entry.id === id)
    if (!spell) return
    if (prepare) {
      const next = toggleBounded(draft.preparedSpellIds, id, preparedLimit)
      if (next === draft.preparedSpellIds) setError(`Можно подготовить не больше ${preparedLimit} заклинаний.`)
      else patch('preparedSpellIds', next)
      return
    }
    const category = spell.level === 0 ? cantrips : leveledSpells
    const maximum = spell.level === 0
      ? cantripLimit
      : spellRules.mode === 'known'
        ? knownLimit
        : spellRules.mode === 'spellbook'
          ? bookLimit
          : 0
    const categoryIds = new Set(category.map((entry) => entry.id))
    const selected = draft.knownSpellIds.filter((value) => categoryIds.has(value))
    const other = draft.knownSpellIds.filter((value) => !categoryIds.has(value))
    const next = toggleBounded(selected, id, maximum)
    if (next === selected) setError(`Больше ${maximum} выбрать нельзя.`)
    else {
      patch('knownSpellIds', [...other, ...next])
      if (!next.includes(id)) patch('preparedSpellIds', draft.preparedSpellIds.filter((value) => value !== id))
    }
  }

  const validateStep = () => {
    if (step >= 3 && draft.abilityMethod === 'point_buy' && (pointBuySpent > 27 || abilityIds.some((id) => draft.abilities[id] < 8 || draft.abilities[id] > 15))) return 'Покупка характеристик: значения 8–15, не более 27 очков.'
    if (step >= 3 && draft.abilityMethod !== 'point_buy' && [...abilityIds.map((ability) => draft.abilities[ability])].sort((a, b) => a - b).join(',') !== [...abilityValues].sort((a, b) => a - b).join(',')) return 'Распределите все шесть полученных значений характеристик.'
    if (!classOption) return 'Выберите поддерживаемый класс.'
    if (step === 1 && (!speciesOption || !selectedSpecies)) return 'Выберите вид.'
    if (step === 1 && !originBonusReady) {
      const count = bonusSource === 'species' ? speciesChoiceCount : originIncreases.length
      return `Отметьте ${count} ${plural(count, ['характеристику', 'характеристики', 'характеристик'])} для прибавок ${bonusSource === 'species' ? 'вида' : 'предыстории'}.`
    }
    if (step === 2 && !draft.backgroundId) return 'Выберите предысторию.'
    if (step === 2 && !backgroundChoicesReady) return 'Завершите выбор языков и инструментов предыстории.'
    if (step === 2 && draft.customBackground && (draft.customBackgroundSkills.length !== 2 || !draft.customFeatureBackground)) return 'Для своей предыстории выберите два навыка и особенность.'
    if ((step === 2 || step === 4) && duplicateBackgroundLanguage) return 'Язык предыстории уже известен от расы. Вернитесь к предыстории и выберите другой.'
    if (step === 4 && replacementSkills.length !== replacementCount) return `Выберите ${replacementCount} новых навыков взамен повторяющихся владений.`
    if (step === 4 && classOption?.subclass_level === 1 && !draft.subclass) return 'Выберите подкласс первого уровня.'
    if (step === 4 && skillRule && draft.classSkillIds.length !== skillRule.choice_count) return `Выберите ${skillRule.choice_count} ${plural(skillRule.choice_count, ['классовый навык', 'классовых навыка', 'классовых навыков'])}.`
    if (step === 4 && !speciesChoicesReady) return 'Завершите расовые выборы.'
    if (step === 4 && catalog.phb && classPreview && !classPreview.ok) return classPreview.errors?.join('; ') ?? 'Завершите классовые выборы PHB.'
    if (step === 4 && speciesOption?.id === 'human-variant' && !featPreview?.ok) return featPreview?.reason ?? 'Выберите черту вариантного человека.'
    if (step === 4 && replacementTools.length !== replacementToolCount) return `Выберите замены инструментальных владений: ${replacementToolCount}.`
    if (step === 4) {
      const incomplete = featureGroups.find((group) => group.options.filter((option) => draft.selectedFeatureIds.includes(option.id)).length !== group.choiceCount)
      if (incomplete) return `${incomplete.name}: выберите ${incomplete.choiceCount}.`
    }
    if (step === 5 && draft.equipmentMode === 'standard' && !starterChoicesReady) return 'Выберите стартовое снаряжение.'
    if (step === 5 && draft.equipmentMode === 'wealth' && (!wealthRoll || wealthRoll.class_id !== draft.classId || purchaseTotal > wealthRoll.total_gp * 100)) return 'Получите бросок богатства выбранного класса и уложитесь в бюджет покупок.'
    if (step === 6 && spellRules) {
      if (selectedCantrips !== cantripLimit) return `Выберите ${cantripLimit} ${plural(cantripLimit, ['заговор', 'заговора', 'заговоров'])}.`
      if (spellRules.mode === 'known' && selectedKnownSpells !== knownLimit) return `Выберите ${knownLimit} ${plural(knownLimit, ['заклинание', 'заклинания', 'заклинаний'])} 1 круга.`
      if (spellRules.mode === 'spellbook' && selectedKnownSpells !== bookLimit) return `Добавьте ${bookLimit} ${plural(bookLimit, ['заклинание', 'заклинания', 'заклинаний'])} в книгу.`
    }
    if (step === 7 && !draft.character.trim()) return 'Назовите персонажа.'
    return ''
  }

  const next = () => {
    const message = validateStep()
    if (message) return setError(message)
    setError('')
    setStep((current) => {
      const nextStep = Math.min(steps.length - 1, current + 1)
      setFurthestStep((furthest) => Math.max(furthest, nextStep))
      return nextStep
    })
  }

  const submit = async () => {
    const message = validateStep()
    if (message) return setError(message)
    if (!classOption || !speciesOption) return
    // Итог обязан равняться стандартному массиву плюс server-owned прибавки:
    // в 2014 они принадлежат виду, в 2024 — предыстории.
    const profileId = bonusSource === 'species'
      ? speciesOption.bonus_profile_id ?? ''
      : selectedBackground ? draft.backgroundAbilityMode : 'none'
    const originBonusProfile = catalog.ability_policy.origin_bonus_profiles.find((profile) => profile.id === profileId)
      ?? catalog.ability_policy.origin_bonus_profiles[0]
    const finalAbilities = { ...draft.abilities }
    for (const ability of abilityIds) {
      finalAbilities[ability] = Math.min(20, draft.abilities[ability] + originBonusFor(ability))
    }
    const document = {
      schema: catalog.import_schema,
      schema_version: catalog.import_schema_version,
      character: {
        character: draft.character.trim(),
        name: accountName,
        role: `${classOption.label} · ур. 1`,
        characterClass: classOption.id,
        species: selectedSpecies,
        ...(catalog.phb ? { phbCreation: { ...draft.phb, backgroundEquipmentChoices: draft.backgroundEquipmentChoices, equipmentMode: draft.equipmentMode,
          ...(draft.equipmentMode === 'wealth' ? { wealthRollId: wealthRoll?.id, purchases: draft.purchases } : {}),
        } } : {}),
        background: draft.background.trim(),
        speciesChoices: draft.speciesChoices,
        starterEquipmentChoices: draft.starterEquipmentChoices,
      ...(draft.backgroundId ? {
        backgroundId: draft.backgroundId,
        ...(bonusSource === 'background' ? { backgroundAbilityChoice: { mode: draft.backgroundAbilityMode, abilities: draft.backgroundAbilities } } : {}),
        backgroundChoices: { tools: draft.backgroundTools, languages: draft.backgroundLanguages, replacementSkills, ...(catalog.phb ? { replacementTools } : {}),
          ...(draft.customBackground ? { customization: { name: draft.customBackgroundName, skills: draft.customBackgroundSkills, toolCount: draft.customToolCount, featureBackgroundId: draft.customFeatureBackground, ...(draft.customVariant ? { variant: draft.customVariant } : {}) } } : {}),
        },
      } : {}),
        traits: draft.appearance.trim(),
        alignment: draft.alignment, ideals: draft.ideals, bonds: draft.bonds, flaws: draft.flaws,
        backstory: draft.backstory.trim(),
        notes: '',
        level: 1,
        experience: 0,
        abilities: finalAbilities,
        abilityGeneration: {
          policyId: catalog.ability_policy.policy_id,
          policyVersion: catalog.ability_policy.policy_version,
          method: draft.abilityMethod,
          ...(draft.abilityMethod === 'rolled' ? { rollId: abilityRoll?.id } : {}),
          baseScores: draft.abilities,
          originBonusProfileId: originBonusProfile.id,
          originBonuses,
          speciesOptionId: speciesOption.id,
        },
        baseSpeed: speciesOption.base_speed,
        hitPointIncreases: [],
        classSkillProficiencies: draft.classSkillIds,
        ...(draft.subclass ? { subclass: draft.subclass } : {}),
        selectedFeatureIds: draft.selectedFeatureIds,
        knownSpellIds: draft.knownSpellIds,
        preparedSpellIds: draft.preparedSpellIds,
      },
    }
    setBusy(true)
    setError('')
    try {
      await onImport(JSON.stringify(document))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать персонажа.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="character-creation-backdrop">
      <section className="character-creation-wizard" role="dialog" aria-modal="true" aria-labelledby="character-creation-title">
        <header>
          <div><Sparkles size={22} /><span><small>МЕСТО ГЕРОЯ · {slotLabel}</small><h2 id="character-creation-title">Создание персонажа</h2></span></div>
          {/* Мастер закрывается всегда. Обязательность героя держит сервер:
              без листа он не примет ход, и об этом сказано подсказкой ниже. */}
          <button type="button" onClick={onClose} aria-label="Закрыть мастер" title="Закрыть"><X size={20} /></button>
        </header>
        <nav aria-label="Шаги создания персонажа">
          {steps.map((entry, index) => <button type="button" key={entry.title} className={index === step ? 'active' : index <= furthestStep ? 'complete' : ''} aria-current={index === step ? 'step' : undefined} disabled={index > furthestStep} onClick={() => setStep(index)}><i>{index < furthestStep ? <Check size={12} /> : index + 1}</i><span><b>{entry.title}</b><small>{entry.description}</small></span></button>)}
        </nav>
        <main>
          {rulesetId === 'dnd_5e_2014' && <p className="creation-ruleset-note"><ShieldCheck size={15} /><span><b>D&D 5e 2014.</b> Раса и подраса дают прибавки к характеристикам; предыстория — навыки, языки, инструменты, особенность и комплект снаряжения. Расовые и фоновые особенности сохраняются в листе, но не все ещё исполняются движком автоматически.</span></p>}
          <aside className="creation-summary-rail" aria-label="Итог героя">
            <small>ИТОГ ГЕРОЯ</small>
            <h3>{draft.character.trim() || 'Безымянный герой'}</h3>
            <dl>
              <div><dt>Класс</dt><dd>{classOption?.label ?? '—'}</dd></div>
              <div><dt>Раса</dt><dd>{selectedSpecies || '—'}</dd></div>
              <div><dt>Предыстория</dt><dd>{selectedBackground?.name ?? '—'}</dd></div>
              <div><dt>Характеристики</dt><dd>{abilityIds.map((ability) => `${abilityLabels[ability].slice(0, 3)} ${draft.abilities[ability] ? draft.abilities[ability] + originBonusFor(ability) : '—'}`).join(' · ')}</dd></div>
              <div><dt>Расовые выборы</dt><dd>{speciesChoiceGroups.flatMap((group) => group.options.filter((option) => (draft.speciesChoices[group.id] ?? []).includes(option.id)).map((option) => option.label)).join(', ') || 'нет'}</dd></div>
              <div><dt>Снаряжение</dt><dd>{starterGroups.flatMap((group) => group.options.filter((option) => (draft.starterEquipmentChoices[group.id] ?? []).includes(option.id)).map((option) => option.label)).join(', ') || 'серверный набор'}</dd></div>
            </dl>
          </aside>
          {/* Английский `entry.id` здесь раньше печатался игроку как есть. */}
          {step === 0 && <div className="creation-card-grid" role="radiogroup" aria-label="Выбор класса">{catalog.classes.map((entry) => {
            const skills = entry.class_skills?.choice_count ?? 0
            const magic = entry.spell_selection && (entry.spell_selection.cantrips > 0 || entry.spell_selection.maximumSpellLevel > 0) ? 'есть магия' : 'без магии на 1 уровне'
            return <button
              type="button"
              role="radio"
              key={entry.id}
              className={draft.classId === entry.id ? 'selected' : ''}
              aria-checked={draft.classId === entry.id}
              aria-label={`${entry.label}: ${skills} навыка на выбор, ${magic}`}
              onClick={() => selectClass(entry.id)}
            ><ClassEmblem classId={entry.id} /><strong>{entry.label}</strong><small>{skills} навыка · {magic}</small></button>
          })}</div>}
          {step === 1 && <div className="creation-form">
            <label><span>Вид</span></label>
            <div className="creation-species" role="radiogroup" aria-label="Выбор расы и подрасы">
              {catalog.ability_policy.species_options.map((entry) => <button
                key={entry.id}
                type="button"
                role="radio"
                className={draft.speciesOptionId === entry.id ? 'selected' : ''}
                aria-checked={draft.speciesOptionId === entry.id}
                onClick={() => selectSpecies(entry)}
              >
                <SpeciesEmblem speciesId={entry.id === 'elf-drow' ? entry.id : entry.race_id ?? entry.id} label={entry.label} />
                <b>{entry.label}</b>
                <small>{entry.base_speed} фт.{entry.size ? ` · ${entry.size === 'small' ? 'Маленький' : 'Средний'}` : ''}</small>
                {entry.bonus_profile_id && <small>{abilityBonusLabel(catalog.ability_policy.origin_bonus_profiles.find((profile) => profile.id === entry.bonus_profile_id))}</small>}
              </button>)}
            </div>
            {speciesOption?.id === 'custom' && <label><span>Название авторского вида</span><input value={draft.customSpecies} onChange={(event) => patch('customSpecies', event.target.value)} maxLength={120} /></label>}
            {bonusSource === 'species' && speciesOption && <div className="creation-origin-bonus">
              <header><span>Прибавки расы и подрасы</span><b>{originBonusReady ? 'готово' : `выберите ${speciesChoiceCount}`}</b></header>
              <p>{speciesBonusProfile?.label}</p>
              {speciesChoiceCount > 0 && <div className="origin-abilities">
                {speciesChoiceOptions.map((ability) => <button
                  key={ability}
                  type="button"
                  className={draft.speciesBonusAbilities.includes(ability) ? 'selected' : ''}
                  aria-pressed={draft.speciesBonusAbilities.includes(ability)}
                  onClick={() => toggleSpeciesAbility(ability)}
                ><span>{abilityLabels[ability]}</span><b>{draft.speciesBonusAbilities.includes(ability) ? `+${speciesChoiceAmount}` : '—'}</b></button>)}
              </div>}
              {(speciesOption.trait_summaries?.length ?? 0) > 0 && <p className="creation-support-note"><ShieldCheck size={13} /><span><b>Расовые особенности:</b> {speciesOption.trait_summaries?.join('; ')}. Они записываются в лист; автоматическое исполнение зависит от конкретной механики.</span></p>}
            </div>}
            <p><ShieldCheck size={17} />{bonusSource === 'species'
              ? 'В редакции 2014 характеристики повышает раса или подраса, а предыстория отвечает за опыт, владения и начальные вещи.'
              : 'Скорость определяется видом. Предыстория редакции 2024 даёт прибавки к характеристикам, два владения навыками, инструмент и черту происхождения.'}</p>
          </div>}
          {step === 2 && <div className="creation-form">
            <div className="creation-backgrounds" role="radiogroup" aria-label="Выбор предыстории">
              {(catalog.backgrounds?.options ?? []).map((option) => {
                const chosen = draft.backgroundId === option.id
                return <button
                  key={option.id}
                  type="button"
                  role="radio"
                  className={chosen ? 'selected' : ''}
                  aria-checked={chosen}
                  onClick={() => selectBackground(option)}
                >
                  <strong>{option.name}</strong>
                  <i>{option.summary}</i>
                  {bonusSource === 'background' && <small><b>Характеристики:</b> {option.abilityOptions.map((ability) => abilityLabels[ability as keyof typeof abilityLabels]).join(', ')}</small>}
                  <small><b>Навыки:</b> {option.skillProficiencies.map((id) => skillNameFor(id)).join(', ')}</small>
                  <small><b>Инструменты:</b> {[...(option.toolProficiencies ?? []).map((entry) => entry.name), ...(option.toolChoice ? [`${option.toolChoice.count} на выбор`] : [])].join(', ') || '—'}</small>
                  {option.languageChoiceCount ? <small><b>Языки:</b> {option.languageChoiceCount} на выбор</small> : null}
                  {option.originFeat && <small><b>Черта:</b> {option.originFeat.name}</small>}
                  {option.feature && <small><b>Особенность:</b> {option.feature.name}</small>}
                  <small><b>Снаряжение:</b> {option.equipment?.summary ?? '—'} · {option.equipment?.gold ?? 0} зм</small>
                </button>
              })}
            </div>
            {selectedBackground && bonusSource === 'background' && <div className="creation-origin-bonus">
              <header><span>Прибавки предыстории</span><b>{originBonusReady ? 'выбрано' : 'выберите раскладку'}</b></header>
              <div className="origin-modes">
                {(catalog.backgrounds?.ability_modes ?? []).map((mode) => <button
                  key={mode.id}
                  type="button"
                  className={draft.backgroundAbilityMode === mode.id ? 'selected' : ''}
                  aria-pressed={draft.backgroundAbilityMode === mode.id}
                  onClick={() => setAbilityMode(mode.id)}
                >{mode.label}</button>)}
              </div>
              <div className="origin-abilities">
                {selectedBackground.abilityOptions.map((ability) => {
                  const index = draft.backgroundAbilities.indexOf(ability)
                  const increases = (catalog.backgrounds?.ability_modes ?? []).find((mode) => mode.id === draft.backgroundAbilityMode)?.increases ?? []
                  return <button
                    key={ability}
                    type="button"
                    className={index >= 0 ? 'selected' : ''}
                    aria-pressed={index >= 0}
                    onClick={() => toggleOriginAbility(ability)}
                  >
                    <span>{abilityLabels[ability as keyof typeof abilityLabels]}</span>
                    <b>{index >= 0 ? `+${increases[index] ?? 1}` : '—'}</b>
                  </button>
                })}
              </div>
              {!catalog.backgrounds?.origin_feats_supported && selectedBackground.originFeat && (
                <p className="creation-support-note">
                  <ShieldCheck size={13} />
                  <span><b>{selectedBackground.originFeat.name}</b> — черта записывается в лист, но движок её пока не применяет.</span>
                </p>
              )}
            </div>}
            {catalog.phb && baseBackground && <section className="creation-form">
              <label><span><input type="checkbox" checked={draft.customBackground} onChange={(event) => {
                setDraft((current) => ({ ...current, customBackground: event.target.checked,
                  customBackgroundName: current.customBackgroundName || 'Своя предыстория', customBackgroundSkills: [...baseBackground.skillProficiencies],
                  customFeatureBackground: baseBackground.id, customToolCount: 0, customVariant: '',
                  backgroundTools: event.target.checked ? [] : (baseBackground.toolChoice?.options ?? []).slice(0, baseBackground.toolChoice?.count ?? 0).map((entry) => entry.id),
                  backgroundLanguages: (catalog.backgrounds?.language_options ?? []).filter((entry) => !speciesLanguages.has(entry.id)).slice(0, event.target.checked ? 2 : baseBackground.languageChoiceCount ?? 0).map((entry) => entry.id),
                }))
              }} /> Настроить предысторию по PHB 2014</span></label>
              {draft.customBackground && <>
                <label>Название предыстории<input value={draft.customBackgroundName} onChange={(event) => patch('customBackgroundName', event.target.value)} /></label>
                <fieldset><legend>Два навыка предыстории</legend>{allSkills.map((skill) => <label key={skill.id}><span><input type="checkbox" checked={draft.customBackgroundSkills.includes(skill.id)} onChange={() => patch('customBackgroundSkills', toggleBounded(draft.customBackgroundSkills, skill.id, 2))} />{skill.name}</span></label>)}</fieldset>
                <label>Инструменты и языки<select value={draft.customToolCount} onChange={(event) => {
                  const count = Number(event.target.value)
                  setDraft((current) => ({ ...current, customToolCount: count,
                    backgroundTools: (catalog.backgrounds?.customization?.tool_options ?? []).slice(0, count).map((entry) => entry.id),
                    backgroundLanguages: (catalog.backgrounds?.language_options ?? []).filter((entry) => !speciesLanguages.has(entry.id)).slice(0, 2 - count).map((entry) => entry.id),
                  }))
                }}><option value={0}>Два языка</option><option value={1}>Один язык и один инструмент</option><option value={2}>Два инструмента</option></select></label>
                <label>Особенность предыстории<select value={draft.customFeatureBackground} onChange={(event) => { patch('customFeatureBackground', event.target.value); patch('customVariant', '') }}>
                  {backgroundOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.feature?.name ?? entry.name}</option>)}
                </select></label>
                <label>Вариант предыстории<select value={draft.customVariant} onChange={(event) => patch('customVariant', event.target.value)}><option value="">Основной вариант</option>
                  {catalog.backgrounds?.customization?.variants.filter((entry) => entry.backgroundId === draft.customFeatureBackground).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select></label>
                <p>Начальные вещи берутся из выбранной карточки предыстории.</p>
              </>}
            </section>}
            {selectedBackground && (toolChoiceCount > 0 || languageChoiceCount > 0) && <div className="creation-origin-bonus">
              <header><span>Выборы предыстории</span><b>{backgroundChoicesReady ? 'готово' : 'завершите выбор'}</b></header>
              {toolChoiceCount > 0 && <>
                <p>Инструменты: {draft.backgroundTools.length}/{toolChoiceCount}</p>
                <div className="origin-abilities">
                  {(selectedBackground.toolChoice?.options ?? []).map((entry) => <button
                    key={entry.id}
                    type="button"
                    className={draft.backgroundTools.includes(entry.id) ? 'selected' : ''}
                    aria-pressed={draft.backgroundTools.includes(entry.id)}
                    onClick={() => toggleBackgroundChoice('backgroundTools', entry.id, toolChoiceCount)}
                  ><span>{entry.name}</span><b>{draft.backgroundTools.includes(entry.id) ? '✓' : '—'}</b></button>)}
                </div>
              </>}
              {languageChoiceCount > 0 && <>
                <p>Языки: {draft.backgroundLanguages.length}/{languageChoiceCount}</p>
                <div className="origin-abilities">
                  {(catalog.backgrounds?.language_options ?? []).map((entry) => <button
                    key={entry.id}
                    type="button"
                    className={draft.backgroundLanguages.includes(entry.id) ? 'selected' : ''}
                    aria-pressed={draft.backgroundLanguages.includes(entry.id)}
                    disabled={speciesLanguages.has(entry.id) && !draft.backgroundLanguages.includes(entry.id)}
                    title={speciesLanguages.has(entry.id) ? 'Уже известен от расы' : undefined}
                    onClick={() => toggleBackgroundChoice('backgroundLanguages', entry.id, languageChoiceCount)}
                  ><span>{entry.name}</span><b>{draft.backgroundLanguages.includes(entry.id) ? '✓' : '—'}</b></button>)}
                </div>
              </>}
            </div>}
            {selectedBackground?.feature && !catalog.backgrounds?.background_features_supported && <p className="creation-support-note"><ShieldCheck size={13} /><span><b>{selectedBackground.feature.name}</b> сохраняется как особенность предыстории, но пока не применяется движком автоматически.</span></p>}
          </div>}
          {step === 3 && <div className="creation-abilities">
            {(catalog.ability_methods?.length ?? 0) > 1 && <label>Способ определения характеристик<select value={draft.abilityMethod} onChange={(event) => {
              const method = event.target.value as CreationDraft['abilityMethod']
              setDraft((current) => ({ ...current, abilityMethod: method, abilities: Object.fromEntries(abilityIds.map((id, index) => [id, method === 'point_buy' ? 8 : method === 'rolled' ? abilityRoll?.scores[index] ?? 0 : catalog.ability_policy.standard_array[index]])) as CharacterAbilityScores }))
              setError('')
            }}>
              <option value="standard_array">Стандартный массив</option><option value="point_buy">Покупка за 27 очков</option><option value="rolled">Серверные броски 4к6</option>
            </select></label>}
            {draft.abilityMethod === 'rolled' && !abilityRoll && <button type="button" disabled={busy || !onRollAbilities} onClick={async () => {
              setBusy(true); setError('')
              try { await onRollAbilities?.() } catch (error) { setError(error instanceof Error ? error.message : 'Ошибка бросков') } finally { setBusy(false) }
            }}>Бросить шесть раз 4к6</button>}
            {draft.abilityMethod === 'point_buy' ? <p>Потрачено {pointBuySpent}/27 очков. Значения 8–13 стоят 0–5 очков, 14 — 7 очков, 15 — 9 очков. Расовые и другие прибавки применяются после покупки.</p>
              : <p>Распределите значения {abilityValues.join(', ') || 'после серверного броска'}. Каждое выпавшее значение используется один раз. Для обмена сначала выберите «Не выбрано».</p>}
            <div>{abilityIds.map((ability) => <label key={ability}><span>{abilityLabels[ability]}</span><select value={draft.abilities[ability]} onChange={(event) => assignAbility(ability, Number(event.target.value))}><option value={0}>Не выбрано</option>{abilityChoices.map((score) => <option key={score} value={score} disabled={draft.abilityMethod !== 'point_buy' && abilityIds.filter((other) => other !== ability && draft.abilities[other] === score).length >= abilityValues.filter((value) => value === score).length}>{score}</option>)}</select><b>{draft.abilities[ability] ? signed(abilityModifier(draft.abilities[ability] + originBonusFor(ability))) : '—'}</b><small>{!draft.abilities[ability] ? 'Выберите значение' : originBonusFor(ability) > 0 ? `+ ${originBonusFor(ability)} ${bonusSource === 'species' ? 'раса' : 'предыстория'} · итог ${draft.abilities[ability] + originBonusFor(ability)}` : `без прибавки ${bonusSource === 'species' ? 'расы' : 'предыстории'}`}</small></label>)}</div>
          </div>}
          {step === 4 && <div className="creation-choices">
            {catalog.phb && <PhbCharacterOptions catalog={catalog.phb} classId={draft.classId} subclass={draft.subclass}
              abilities={preFeatAbilities} knownSkillIds={[...knownSkills, ...replacementSkills]} knownToolIds={[...knownTools, ...replacementTools]}
              variantHuman={speciesOption?.id === 'human-variant'} value={draft.phb} onChange={(value) => patch('phb', value)} />}
            {replacementToolCount > 0 && <section aria-label="Замена повторяющихся инструментов"><header><span>Замена повторяющихся инструментов</span><b>{replacementTools.length}/{replacementToolCount}</b></header><div>
              {catalog.phb?.tools.filter((tool) => !knownTools.has(tool.id)).map((tool) => <button key={tool.id} type="button" aria-pressed={replacementTools.includes(tool.id)} className={replacementTools.includes(tool.id) ? 'selected' : ''} onClick={() => patch('backgroundReplacementTools', toggleBounded(replacementTools, tool.id, replacementToolCount))}>{tool.label ?? tool.name}</button>)}
            </div></section>}
            {classOption?.subclass_level === 1 && <section className="creation-form">
              <label>Подкласс первого уровня<select value={draft.subclass} onChange={(event) => patch('subclass', event.target.value)}>
                <option value="">Выберите подкласс</option>
                {classOption.subclasses.map((subclass) => <option key={subclass.id} value={subclass.name}>{subclass.name}</option>)}
              </select></label>
              <p>Выбор сохраняется в листе. Автоматическое исполнение особенностей подкласса пока частичное.</p>
            </section>}
            {speciesChoiceGroups.map((group) => <section key={group.id} className="creation-choice-group">
              <header><span>{group.label}</span><b aria-live="polite">{(draft.speciesChoices[group.id] ?? []).length}/{group.count}</b></header>
              <div>{group.options.map((option) => {
                const selected = (draft.speciesChoices[group.id] ?? []).includes(option.id)
                return <button
                  key={option.id}
                  type="button"
                  className={selected ? 'selected' : ''}
                  aria-pressed={selected}
                  disabled={group.kind === 'language' && !selected && ((speciesOption?.languages ?? []).includes(option.id) || draft.backgroundLanguages.includes(option.id))}
                  onClick={() => toggleCatalogChoice('speciesChoices', group.id, option.id, group.count)}
                ><Check size={13} /><span><b>{option.label}</b>{option.damage_type && <small>{option.shape === 'line' ? 'Линия' : 'Конус'} · {option.distance_feet} фт. · {option.damage_type}</small>}</span></button>
              })}</div>
            </section>)}
            <section><header><span>Классовые навыки</span><b>{draft.classSkillIds.length}/{skillRule?.choice_count ?? 0}</b></header><div>{skillRule?.options.map((skill) => <button key={skill.id} className={draft.classSkillIds.includes(skill.id) ? 'selected' : ''} aria-label={`${skill.name}: ${skillHintFor(skill.id) || abilityLabels[skill.ability]}`} onClick={() => toggleSkill(skill.id)}><Check size={13} /><span><b>{skill.name}</b><small>{abilityLabels[skill.ability]}</small>{skillHintFor(skill.id) && <i>{skillHintFor(skill.id)}</i>}</span></button>)}</div></section>
            {replacementCount > 0 && <section aria-label="Замена повторяющихся навыков">
              <header><span>Замена повторяющихся навыков</span><b>{replacementSkills.length}/{replacementCount}</b></header>
              <p>Раса, класс или предыстория дают одинаковое владение. Выберите другой навык взамен каждого повтора.</p>
              <div>{allSkills.filter((skill) => !knownSkills.has(skill.id)).map((skill) => <button
                key={skill.id} type="button" aria-pressed={replacementSkills.includes(skill.id)}
                className={replacementSkills.includes(skill.id) ? 'selected' : ''}
                onClick={() => patch('backgroundReplacementSkills', toggleBounded(replacementSkills, skill.id, replacementCount))}
              ><Check size={13} />{skill.name}</button>)}</div>
            </section>}
            {featureGroups.map((group) => <section key={group.id}><header><span>{group.name}</span><b>{group.options.filter((option) => draft.selectedFeatureIds.includes(option.id)).length}/{group.choiceCount}</b></header><div>{group.options.map((option) => <button key={option.id} className={draft.selectedFeatureIds.includes(option.id) ? 'selected' : ''} aria-label={FEATURE_HINTS[option.id] ? `${option.name}: ${FEATURE_HINTS[option.id]}` : option.name} title={FEATURE_HINTS[option.id]} onClick={() => toggleFeature(group, option.id)}><Check size={13} />{option.name}{FEATURE_HINTS[option.id] && <small>{FEATURE_HINTS[option.id]}</small>}</button>)}</div></section>)}
          </div>}
          {step === 5 && <div className="creation-equipment-groups">
            {catalog.phb && <label className="creation-form">Стартовое снаряжение<select value={draft.equipmentMode} onChange={(event) => patch('equipmentMode', event.target.value as 'standard' | 'wealth')}><option value="standard">Наборы класса и предыстории</option><option value="wealth">Стартовое богатство и покупки</option></select></label>}
            {draft.equipmentMode === 'wealth' && <section className="creation-form">
              <p>Этот вариант заменяет вещи и деньги класса и предыстории. Купленные предметы можно надеть в инвентаре после создания.</p>
              {!wealthRoll ? <button type="button" disabled={busy || !onRollWealth} onClick={async () => { setBusy(true); setError(''); try { await onRollWealth?.(draft.classId) } catch (error) { setError(error instanceof Error ? error.message : 'Ошибка броска') } finally { setBusy(false) } }}>Бросить стартовое богатство</button> : <p>Получено {wealthRoll.total_gp} зм · потрачено {purchaseTotal / 100} зм · осталось {(wealthRoll.total_gp * 100 - purchaseTotal) / 100} зм</p>}
              <label>Предмет<select value={draft.purchaseId} onChange={(event) => patch('purchaseId', event.target.value)}><option value="">Выберите предмет</option>{catalog.starting_wealth?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.price_cp / 100} зм</option>)}</select></label>
              <label>Количество<input type="number" min={1} max={1000} value={draft.purchaseQuantity} onChange={(event) => patch('purchaseQuantity', Number(event.target.value))} /></label>
              <button type="button" disabled={!draft.purchaseId || !Number.isInteger(draft.purchaseQuantity) || draft.purchaseQuantity < 1} onClick={() => patch('purchases', [...draft.purchases, { id: draft.purchaseId, quantity: draft.purchaseQuantity }])}>Добавить покупку</button>
              {draft.purchases.map((item, index) => <div key={index}>{catalog.starting_wealth?.items.find((entry) => entry.id === item.id)?.name} ×{item.quantity} <button type="button" onClick={() => patch('purchases', draft.purchases.filter((_, at) => at !== index))}>Убрать</button></div>)}
            </section>}
            {draft.equipmentMode === "standard" && catalog.starter_equipment?.backgrounds?.find((entry) => entry.background_id === draft.backgroundId)?.choice_groups.map((group) => <section className="creation-form" key={group.id}><label>{group.label} · предыстория<select value={draft.backgroundEquipmentChoices[group.id]?.[0] ?? group.options[0]?.id ?? ''} onChange={(event) => patch('backgroundEquipmentChoices', { ...draft.backgroundEquipmentChoices, [group.id]: [event.target.value] })}>{group.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label></section>)}
            {draft.equipmentMode === "wealth" ? null : !starterProfile ? <div className="creation-empty"><ShieldCheck size={24} /><strong>Набор определит сервер</strong><p>Для этой редакции нет отдельных вариантов снаряжения.</p></div> : <>
              {(starterProfile.fixed_items?.length || starterProfile.fixed_narrative_items?.length) ? <section className="creation-equipment-fixed">
                <header><span>Всегда в наборе</span><b>закреплено классом</b></header>
                <p>{[
                  ...(starterProfile.fixed_items ?? []).map((item) => `${item.name ?? 'Предмет'}${(item.quantity ?? 1) > 1 ? ` ×${item.quantity}` : ''}`),
                  ...(starterProfile.fixed_narrative_items ?? []).map((item) => item.name),
                ].filter(Boolean).join(' · ')}</p>
              </section> : null}
              {starterGroups.map((group) => <section key={group.id} className="creation-equipment-group">
                <header><span>{group.label}</span><b aria-live="polite">{(draft.starterEquipmentChoices[group.id] ?? []).length}/{group.count}</b></header>
                <div>{group.options.length > 12 ? <select aria-label={group.label} value={draft.starterEquipmentChoices[group.id]?.[0] ?? ''} onChange={(event) => patch('starterEquipmentChoices', { ...draft.starterEquipmentChoices, [group.id]: [event.target.value] })}><option value="">Выберите вариант</option>{group.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : group.options.map((option) => {
                  const selected = (draft.starterEquipmentChoices[group.id] ?? []).includes(option.id)
                  return <button
                    key={option.id}
                    type="button"
                    className={`creation-equipment-option ${selected ? 'selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => toggleCatalogChoice('starterEquipmentChoices', group.id, option.id, group.count)}
                  ><span><Check size={15} /><strong>{option.label}</strong></span><small>{option.summary}</small><i>{[
                    ...(option.items ?? []).map((item) => `${item.name ?? 'Предмет'}${(item.quantity ?? 1) > 1 ? ` ×${item.quantity}` : ''}`),
                    ...(option.narrative_items ?? []).map((item) => item.name),
                  ].filter(Boolean).join(' · ')}</i></button>
                })}</div>
              </section>)}
            </>}
          </div>}
          {step === 6 && <div className="creation-spells">
            {catalog.phb && <p>Выбирайте заклинания PHB для листа. Статус карточки показывает, какие эффекты уже исполняются движком, а какие пока требуют решения ведущего.</p>}
            {domainSpellIds.length > 0 && <p>Заклинания домена всегда подготовлены и не занимают лимит: {domainSpellIds.map((id) => catalog.phb?.spells.find((spell) => spell.id === id)?.name ?? id).join(', ')}.</p>}
            {!spellRules ? <div className="creation-empty"><ShieldCheck size={24} /><strong>На 1 уровне у этого класса нет выбора заклинаний</strong><p>Доступ к магии на следующих уровнях зависит от класса и подкласса.</p></div> : <>
              <label className="creation-spell-search">
                <span className="visually-hidden">Поиск заклинания</span>
                <input
                  type="search"
                  value={spellSearch}
                  onChange={(event) => setSpellSearch(event.target.value)}
                  placeholder="Название или эффект…"
                  aria-label="Поиск заклинания по названию или эффекту"
                />
              </label>
              {cantrips.length > 0 && <section><header><span>Заговоры</span><b>{selectedCantrips}/{cantripLimit}</b></header>{cantripSupport && <p className="creation-support-note"><ShieldCheck size={13} /><span><b>{cantripSupport.label}</b> — {cantripSupport.explanation}</span></p>}<div>{visibleCantrips.map((spell) => <SpellChoice key={spell.id} spell={spell} selected={draft.knownSpellIds.includes(spell.id)} showSupport={!cantripSupport} onClick={() => toggleSpell(spell.id)} />)}</div></section>}
              {leveledSpells.length > 0 && <section><header><span>Заклинания 1 круга</span><b>{spellRules.mode === 'known' ? `${selectedKnownSpells}/${knownLimit}` : spellRules.mode === 'spellbook' ? `книга ${selectedKnownSpells}/${bookLimit}` : `подготовлено ${selectedPreparedSpells}/${preparedLimit}`}</b></header>{leveledSupport && <p className="creation-support-note"><ShieldCheck size={13} /><span><b>{leveledSupport.label}</b> — {leveledSupport.explanation}</span></p>}<div>{visibleLeveledSpells.map((spell) => {
                const preparedMode = spellRules.mode === 'prepared'
                const inBook = draft.knownSpellIds.includes(spell.id)
                return <SpellChoice key={spell.id} spell={spell} showSupport={!leveledSupport} selected={preparedMode ? draft.preparedSpellIds.includes(spell.id) : inBook} secondary={spellRules.mode === 'spellbook' && inBook ? { selected: draft.preparedSpellIds.includes(spell.id), onClick: () => toggleSpell(spell.id, true) } : undefined} onClick={() => preparedMode ? toggleSpell(spell.id, true) : toggleSpell(spell.id)} />
              })}</div></section>}
            </>}
          </div>}
          {step === 7 && <div className="creation-form identity">
            <label>Мировоззрение<select value={draft.alignment} onChange={(event) => patch('alignment', event.target.value)}><option value="">Не определено</option>{['Законопослушный добрый', 'Нейтральный добрый', 'Хаотичный добрый', 'Законопослушный нейтральный', 'Истинно нейтральный', 'Хаотичный нейтральный', 'Законопослушный злой', 'Нейтральный злой', 'Хаотичный злой'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Идеал<textarea value={draft.ideals} onChange={(event) => patch('ideals', event.target.value)} maxLength={2000} /></label>
            <label>Привязанность<textarea value={draft.bonds} onChange={(event) => patch('bonds', event.target.value)} maxLength={2000} /></label>
            <label>Слабость<textarea value={draft.flaws} onChange={(event) => patch('flaws', event.target.value)} maxLength={2000} /></label>
            <label><span>Имя героя</span><input aria-label="Имя героя" value={draft.character} onChange={(event) => patch('character', event.target.value)} maxLength={120} autoFocus /></label>
            <label><span>Внешность и характер</span><textarea aria-label="Внешность и характер" value={draft.appearance} onChange={(event) => patch('appearance', event.target.value)} maxLength={2000} rows={4} /></label>
            <label><span>Предыстория и личный мотив</span><textarea aria-label="Предыстория и личный мотив" value={draft.backstory} onChange={(event) => patch('backstory', event.target.value)} maxLength={8000} rows={6} /></label>
            <div className="creation-summary"><ShieldCheck size={18} /><span><b>{classOption?.label} · {selectedSpecies}</b><small>Уровень, ОЗ, КД, скорость и бонус мастерства посчитаются сами по листу героя.</small></span></div>
          </div>}
        </main>
        <footer>
          <div className={error ? 'creation-error' : ''} role={error ? 'alert' : undefined}>
            {error || (required
              ? 'Пока герой не создан, ходить он не может. Мастер можно закрыть и вернуться позже.'
              : '')}
          </div>
          <span>
            {/* Готовый герой одним нажатием: заполняет все шаги валидными
                значениями, дальше их можно править вручную. */}
            <button
              className="creation-roll"
              disabled={busy}
              title="Заполнить все шаги случайным, но корректным героем"
              type="button"
              onClick={rollRandomHero}
            ><Sparkles size={15} />Случайный герой</button>
            <button type="button" disabled={step === 0 || busy} onClick={() => setStep((current) => Math.max(0, current - 1))}><ArrowLeft size={15} />Назад</button>
            {step < steps.length - 1
              ? <button type="button" className="primary" onClick={next}>Дальше<ArrowRight size={15} /></button>
              : <button type="button" className="primary" disabled={busy} onClick={() => { void submit() }}><ShieldCheck size={15} />{busy ? 'Создаём героя…' : 'Создать героя'}</button>}
          </span>
        </footer>
      </section>
    </div>
  )
}

function SpellChoice({
  spell,
  selected,
  secondary,
  showSupport = true,
  onClick,
}: {
  spell: NonNullable<CharacterCreationCatalog['classes'][number]['spell_selection']>['spells'][number]
  selected: boolean
  secondary?: { selected: boolean; onClick: () => void }
  showSupport?: boolean
  onClick: () => void
}) {
  // Тот же словарь статусов, что и в бою: в мастере раньше печатался сырой
  // `partial`/`heuristic`, а неисполнимые карточки можно было выбрать — игрок
  // собирал книгу, половину которой движок потом отказывался применять.
  const support = mechanicsSupportPresentation(spell.mechanics_support)
  const blocked = support.blocked
  // Список одних названий не давал понять, что заклинание делает: описание,
  // время накладывания и дальность приходили с сервера и никуда не выводились.
  const meta = [spell.casting_time, spell.range_text].filter(Boolean).join(' · ')
  return <article className={`${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`.trim()}>
    <button
      onClick={onClick}
      aria-label={`${spell.name}, ${spell.level === 0 ? 'заговор' : 'заклинание 1 круга'}, ${support.label}`}
      title={spell.description || support.explanation}
    >
      <CombatIcon id={spell.id} kind="spell" hint={spell.name} size={52} />
      <span>
        <strong>{spell.name}</strong>
        <small>{spell.level === 0 ? 'заговор' : '1 круг'}{meta ? ` · ${meta}` : ''}{showSupport ? ` · ${support.shortLabel}` : ''}</small>
        {spell.description && <i>{spell.description}</i>}
      </span><Check size={14} />
    </button>
    {secondary && <button className={secondary.selected ? 'prepare selected' : 'prepare'} onClick={secondary.onClick}>{secondary.selected ? 'Подготовлено' : 'Подготовить'}</button>}
  </article>
}
