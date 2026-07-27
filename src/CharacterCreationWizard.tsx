import { useEffect, useMemo, useState } from 'react'
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
            ><strong>{entry.label}</strong><small>{skills} навыка · {magic}</small></button>
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
            <section><header><span>Классовые навыки</span><b>{draft.classSkillIds.length}/{skillRule?.choice_count ?? 0}</b></header><div>{skillRule?.options.map((skill) => <button key={skill.id} className={draft.classSkillIds.includes(skill.id) ? 'selected' : ''} onClick={() => toggleSkill(skill.id)}><Check size={13} />{skill.name}<small>{abilityLabels[skill.ability]}</small></button>)}</div></section>
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
