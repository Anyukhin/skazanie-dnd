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
import './character-creation.css'

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
  'sleight-of-hand': 'Незаметно взять, подменить, спрятать предмет, вскрыть замок.',
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
  barbarian: <><path d="M5 19 14 10" /><path d="M12 4c4 0 7 2 7 5 0 2-2 3-4 3-3 0-5-2-5-5" /><path d="m4 20 3-3" /></>,
  bard: <><circle cx="9" cy="16" r="5" /><path d="M13 12 19 5" /><path d="m16 4 4 1 1 4" /></>,
  cleric: <><path d="M12 3v18" /><path d="M6 8h12" /><circle cx="12" cy="12" r="9" /></>,
  druid: <><path d="M12 21c0-7 3-12 8-15-6-1-11 2-12 8-1 4 1 7 4 7Z" /><path d="M12 21c-1-4-3-6-6-7" /></>,
  fighter: <><path d="m5 19 9-9" /><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="m4 16 4 4" /></>,
  monk: <><circle cx="12" cy="12" r="9" /><path d="M8 13c2 2 6 2 8 0" /><path d="M9 9h.01M15 9h.01" /></>,
  paladin: <><path d="M12 3 4 6v6c0 5 3 8 8 9 5-1 8-4 8-9V6Z" /><path d="M12 8v7" /><path d="M9 11h6" /></>,
  ranger: <><path d="M6 3c6 3 9 9 9 18" /><path d="M6 3 4 9" /><path d="m6 3 6 1" /><path d="M14 14 21 7" /></>,
  rogue: <><path d="m6 18 9-9" /><path d="M15 5h4v4" /><path d="m5 17 2 2" /><circle cx="9" cy="15" r="1" /></>,
  sorcerer: <><path d="M12 3c3 5 6 6 6 10a6 6 0 0 1-12 0c0-4 3-5 6-10Z" /><path d="M12 20c-2 0-3-1-3-3 0-2 3-3 3-6" /></>,
  warlock: <><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  wizard: <><path d="M4 6h11a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3Z" /><path d="M4 6a3 3 0 0 1 3-3h11" /><path d="M11 11h4" /></>,
}

function ClassEmblem({ classId }: { classId: string }) {
  const glyph = CLASS_EMBLEMS[classId]
  if (!glyph) return null
  return <svg className="class-emblem" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyph}</svg>
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
  classId: string
  speciesOptionId: string
  customSpecies: string
  background: string
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

function initialDraft(catalog: CharacterCreationCatalog): CreationDraft {
  const assigned = emptyScores()
  abilityIds.forEach((ability, index) => { assigned[ability] = catalog.ability_policy.standard_array[index] ?? 10 })
  return {
    classId: catalog.classes[0]?.id ?? '',
    speciesOptionId: catalog.ability_policy.species_options[0]?.id ?? '',
    customSpecies: '',
    background: '',
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
  required = false,
  onClose,
  onImport,
}: {
  player: Player
  accountName: string
  catalog: CharacterCreationCatalog
  required?: boolean
  onClose: () => void
  onImport: (source: string) => Promise<void>
}) {
  const [step, setStep] = useState(0)
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
  const classOption = catalog.classes.find((entry) => entry.id === draft.classId) ?? catalog.classes[0]
  const speciesOption = catalog.ability_policy.species_options.find((entry) => entry.id === draft.speciesOptionId)
  const skillRule = classOption?.class_skills
  const featureGroups = classOption?.feature_choice_groups ?? []
  const spellRules = classOption?.spell_selection
  // Неисполнимые карточки не предлагаются к выбору, поэтому и лимиты считаем
  // от того, что реально можно взять: иначе класс с бедным каталогом запер бы
  // мастер на недостижимом «выберите 3 заговора».
  const selectable = (spell: { mechanics_support?: MechanicsSupport | null }) => !mechanicsSupportPresentation(spell.mechanics_support ?? undefined).blocked
  const cantrips = spellRules?.spells.filter((spell) => spell.level === 0 && selectable(spell)) ?? []
  const leveledSpells = spellRules?.spells.filter((spell) => spell.level === 1 && selectable(spell)) ?? []
  const selectedCantrips = cantrips.filter((spell) => draft.knownSpellIds.includes(spell.id)).length
  const selectedKnownSpells = leveledSpells.filter((spell) => draft.knownSpellIds.includes(spell.id)).length
  const selectedPreparedSpells = leveledSpells.filter((spell) => draft.preparedSpellIds.includes(spell.id)).length
  const selectedSpecies = speciesOption?.id === 'custom' ? draft.customSpecies.trim() : speciesOption?.label ?? ''
  const cantripLimit = Math.min(spellRules?.cantrips ?? 0, cantrips.length)
  const knownLimit = Math.min(spellRules?.spellsKnown ?? 0, leveledSpells.length)
  const bookLimit = Math.min(spellRules?.spellbookMinimum ?? 0, leveledSpells.length)
  const preparedLimit = Math.min(spellRules?.preparedLimit ?? 0, leveledSpells.length)
  const cantripSupport = sharedSupport(cantrips)
  const leveledSupport = sharedSupport(leveledSpells)

  const steps = useMemo(() => [
    { title: 'Класс', description: 'Двенадцать классов на выбор' },
    { title: 'Происхождение', description: 'Вид и предыстория' },
    { title: 'Характеристики', description: 'Стандартный массив' },
    { title: 'Навыки', description: 'Классовый выбор' },
    { title: 'Магия', description: 'Заговоры и 1 круг' },
    { title: 'Личность', description: 'Имя и история' },
  ], [])

  const patch = <K extends keyof CreationDraft>(key: K, value: CreationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
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
    const entry = pick(catalog.classes)
    if (!entry) return
    // Авторский вид требует ручного названия — случайному герою он не подходит.
    const species = pick(catalog.ability_policy.species_options.filter((option) => option.id !== 'custom'))
      ?? catalog.ability_policy.species_options[0]
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
      speciesOptionId: species?.id ?? current.speciesOptionId,
      customSpecies: '',
      background: pick(RANDOM_BACKGROUNDS) ?? 'странник',
      abilities,
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
      classSkillIds: [],
      selectedFeatureIds: [],
      knownSpellIds: [],
      preparedSpellIds: [],
    }))
    setError('')
  }

  const assignAbility = (ability: keyof CharacterAbilityScores, score: number) => {
    setDraft((current) => {
      const previous = current.abilities[ability]
      const swapAbility = abilityIds.find((candidate) => candidate !== ability && current.abilities[candidate] === score)
      return {
        ...current,
        abilities: {
          ...current.abilities,
          [ability]: score,
          ...(swapAbility ? { [swapAbility]: previous } : {}),
        },
      }
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
    if (!classOption) return 'Выберите поддерживаемый класс.'
    if (step === 1 && (!speciesOption || !selectedSpecies || !draft.background.trim())) return 'Выберите вид и укажите предысторию.'
    if (step === 3 && skillRule && draft.classSkillIds.length !== skillRule.choice_count) return `Выберите ${skillRule.choice_count} ${plural(skillRule.choice_count, ['классовый навык', 'классовых навыка', 'классовых навыков'])}.`
    if (step === 3) {
      const incomplete = featureGroups.find((group) => group.options.filter((option) => draft.selectedFeatureIds.includes(option.id)).length !== group.choiceCount)
      if (incomplete) return `${incomplete.name}: выберите ${incomplete.choiceCount}.`
    }
    if (step === 4 && spellRules) {
      if (selectedCantrips !== cantripLimit) return `Выберите ${cantripLimit} ${plural(cantripLimit, ['заговор', 'заговора', 'заговоров'])}.`
      if (spellRules.mode === 'known' && selectedKnownSpells !== knownLimit) return `Выберите ${knownLimit} ${plural(knownLimit, ['заклинание', 'заклинания', 'заклинаний'])} 1 круга.`
      if (spellRules.mode === 'spellbook' && selectedKnownSpells !== bookLimit) return `Добавьте ${bookLimit} ${plural(bookLimit, ['заклинание', 'заклинания', 'заклинаний'])} в книгу.`
    }
    if (step === 5 && !draft.character.trim()) return 'Назовите персонажа.'
    return ''
  }

  const next = () => {
    const message = validateStep()
    if (message) return setError(message)
    setError('')
    setStep((current) => Math.min(steps.length - 1, current + 1))
  }

  const submit = async () => {
    const message = validateStep()
    if (message) return setError(message)
    if (!classOption || !speciesOption) return
    const originBonusProfile = catalog.ability_policy.origin_bonus_profiles[0]
    const originBonuses = emptyScores()
    abilityIds.forEach((ability) => { originBonuses[ability] = 0 })
    const document = {
      schema: catalog.import_schema,
      schema_version: catalog.import_schema_version,
      character: {
        character: draft.character.trim(),
        name: accountName,
        role: `${classOption.label} · ур. 1`,
        characterClass: classOption.id,
        species: selectedSpecies,
        background: draft.background.trim(),
        traits: draft.appearance.trim(),
        backstory: draft.backstory.trim(),
        notes: '',
        level: 1,
        experience: 0,
        abilities: draft.abilities,
        abilityGeneration: {
          policyId: catalog.ability_policy.policy_id,
          policyVersion: catalog.ability_policy.policy_version,
          method: catalog.ability_policy.method,
          baseScores: draft.abilities,
          originBonusProfileId: originBonusProfile.id,
          originBonuses,
          speciesOptionId: speciesOption.id,
        },
        baseSpeed: speciesOption.base_speed,
        hitPointIncreases: [],
        classSkillProficiencies: draft.classSkillIds,
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
          <button onClick={onClose} aria-label="Закрыть мастер" title="Закрыть"><X size={20} /></button>
        </header>
        <nav aria-label="Шаги создания персонажа">
          {steps.map((entry, index) => <button key={entry.title} className={index === step ? 'active' : index < step ? 'complete' : ''} onClick={() => index <= step && setStep(index)}><i>{index < step ? <Check size={12} /> : index + 1}</i><span><b>{entry.title}</b><small>{entry.description}</small></span></button>)}
        </nav>
        <main>
          {/* Английский `entry.id` здесь раньше печатался игроку как есть. */}
          {step === 0 && <div className="creation-card-grid" role="group" aria-label="Выбор класса">{catalog.classes.map((entry) => {
            const skills = entry.class_skills?.choice_count ?? 0
            const magic = entry.spell_selection ? 'есть магия' : 'без магии на 1 уровне'
            return <button
              key={entry.id}
              className={draft.classId === entry.id ? 'selected' : ''}
              aria-pressed={draft.classId === entry.id}
              aria-label={`${entry.label}: ${skills} навыка на выбор, ${magic}`}
              onClick={() => selectClass(entry.id)}
            ><ClassEmblem classId={entry.id} /><strong>{entry.label}</strong><small>{skills} навыка · {magic}</small></button>
          })}</div>}
          {step === 1 && <div className="creation-form">
            <label><span>Вид</span><select value={draft.speciesOptionId} onChange={(event) => patch('speciesOptionId', event.target.value)}>{catalog.ability_policy.species_options.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.base_speed} фт.</option>)}</select></label>
            {speciesOption?.id === 'custom' && <label><span>Название авторского вида</span><input value={draft.customSpecies} onChange={(event) => patch('customSpecies', event.target.value)} maxLength={120} /></label>}
            <label><span>Предыстория</span><input value={draft.background} onChange={(event) => patch('background', event.target.value)} placeholder="Например: солдат, учёная, странник" maxLength={160} /></label>
            <p><ShieldCheck size={17} />Скорость определяется видом. Происхождение даёт умения и снаряжение, а не прибавки к характеристикам.</p>
          </div>}
          {step === 2 && <div className="creation-abilities">
            <p>Распределите значения {catalog.ability_policy.standard_array.join(', ')}. При выборе уже занятого значения мастер автоматически меняет характеристики местами.</p>
            <div>{abilityIds.map((ability) => <label key={ability}><span>{abilityLabels[ability]}</span><select value={draft.abilities[ability]} onChange={(event) => assignAbility(ability, Number(event.target.value))}>{catalog.ability_policy.standard_array.map((score) => <option key={score} value={score}>{score}</option>)}</select><b>{signed(abilityModifier(draft.abilities[ability]))}</b><small>+ 0 происхождение</small></label>)}</div>
          </div>}
          {step === 3 && <div className="creation-choices">
            <section><header><span>Классовые навыки</span><b>{draft.classSkillIds.length}/{skillRule?.choice_count ?? 0}</b></header><div>{skillRule?.options.map((skill) => <button key={skill.id} className={draft.classSkillIds.includes(skill.id) ? 'selected' : ''} aria-label={`${skill.name}: ${skillHintFor(skill.id) || abilityLabels[skill.ability]}`} onClick={() => toggleSkill(skill.id)}><Check size={13} /><span><b>{skill.name}</b><small>{abilityLabels[skill.ability]}</small>{skillHintFor(skill.id) && <i>{skillHintFor(skill.id)}</i>}</span></button>)}</div></section>
            {featureGroups.map((group) => <section key={group.id}><header><span>{group.name}</span><b>{group.options.filter((option) => draft.selectedFeatureIds.includes(option.id)).length}/{group.choiceCount}</b></header><div>{group.options.map((option) => <button key={option.id} className={draft.selectedFeatureIds.includes(option.id) ? 'selected' : ''} aria-label={FEATURE_HINTS[option.id] ? `${option.name}: ${FEATURE_HINTS[option.id]}` : option.name} title={FEATURE_HINTS[option.id]} onClick={() => toggleFeature(group, option.id)}><Check size={13} />{option.name}{FEATURE_HINTS[option.id] && <small>{FEATURE_HINTS[option.id]}</small>}</button>)}</div></section>)}
          </div>}
          {step === 4 && <div className="creation-spells">
            {!spellRules ? <div className="creation-empty"><ShieldCheck size={24} /><strong>На 1 уровне у этого класса нет выбора заклинаний</strong><p>Заклинания появятся на следующих уровнях.</p></div> : <>
              {cantrips.length > 0 && <section><header><span>Заговоры</span><b>{selectedCantrips}/{cantripLimit}</b></header>{cantripSupport && <p className="creation-support-note"><ShieldCheck size={13} /><span><b>{cantripSupport.label}</b> — {cantripSupport.explanation}</span></p>}<div>{cantrips.map((spell) => <SpellChoice key={spell.id} spell={spell} selected={draft.knownSpellIds.includes(spell.id)} showSupport={!cantripSupport} onClick={() => toggleSpell(spell.id)} />)}</div></section>}
              {leveledSpells.length > 0 && <section><header><span>Заклинания 1 круга</span><b>{spellRules.mode === 'known' ? `${selectedKnownSpells}/${knownLimit}` : spellRules.mode === 'spellbook' ? `книга ${selectedKnownSpells}/${bookLimit}` : `подготовлено ${selectedPreparedSpells}/${preparedLimit}`}</b></header>{leveledSupport && <p className="creation-support-note"><ShieldCheck size={13} /><span><b>{leveledSupport.label}</b> — {leveledSupport.explanation}</span></p>}<div>{leveledSpells.map((spell) => {
                const preparedMode = spellRules.mode === 'prepared'
                const inBook = draft.knownSpellIds.includes(spell.id)
                return <SpellChoice key={spell.id} spell={spell} showSupport={!leveledSupport} selected={preparedMode ? draft.preparedSpellIds.includes(spell.id) : inBook} secondary={spellRules.mode === 'spellbook' && inBook ? { selected: draft.preparedSpellIds.includes(spell.id), onClick: () => toggleSpell(spell.id, true) } : undefined} onClick={() => preparedMode ? toggleSpell(spell.id, true) : toggleSpell(spell.id)} />
              })}</div></section>}
            </>}
          </div>}
          {step === 5 && <div className="creation-form identity">
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
              onClick={rollRandomHero}
            ><Sparkles size={15} />Случайный герой</button>
            <button disabled={step === 0 || busy} onClick={() => setStep((current) => Math.max(0, current - 1))}><ArrowLeft size={15} />Назад</button>
            {step < steps.length - 1
              ? <button className="primary" onClick={next}>Дальше<ArrowRight size={15} /></button>
              : <button className="primary" disabled={busy} onClick={() => { void submit() }}><ShieldCheck size={15} />{busy ? 'Создаём героя…' : 'Создать героя'}</button>}
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
  return <article className={`${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`.trim()}>
    <button
      onClick={onClick}
      disabled={blocked}
      aria-label={`${spell.name}, ${spell.level === 0 ? 'заговор' : 'заклинание 1 круга'}, ${support.label}`}
      title={support.explanation}
    >
      <span><strong>{spell.name}</strong><small>{spell.level === 0 ? 'заговор' : '1 круг'}{showSupport ? ` · ${support.shortLabel}` : ''}</small></span><Check size={14} />
    </button>
    {secondary && <button className={secondary.selected ? 'prepare selected' : 'prepare'} onClick={secondary.onClick}>{secondary.selected ? 'Подготовлено' : 'Подготовить'}</button>}
  </article>
}
