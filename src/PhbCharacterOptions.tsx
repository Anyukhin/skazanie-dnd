import './character-creation.css'
import { useState } from 'react'

import type { PhbAbilityId, PhbChoiceRecord, PhbCatalogEntry, PhbSpellCatalogEntry, PhbFeatCatalogEntry, PhbChoiceSchema, PhbClassCatalogEntry, PhbSubclassCatalogEntry, PhbCharacterOptionsCatalog, PhbFeatSelection, PhbCharacterOptionsValue, PhbCharacterOptionsProps } from './phb-character-types'
export type { PhbAbilityId, PhbChoiceRecord, PhbCatalogEntry, PhbSpellCatalogEntry, PhbFeatCatalogEntry, PhbChoiceSchema, PhbClassCatalogEntry, PhbSubclassCatalogEntry, PhbCharacterOptionsCatalog, PhbFeatSelection, PhbCharacterOptionsValue, PhbCharacterOptionsProps } from './phb-character-types'

const ABILITY_LABELS: Record<PhbAbilityId, string> = {
  str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма',
}
const DAMAGE_LABELS: Record<string, string> = {
  acid: 'Кислота', cold: 'Холод', fire: 'Огонь', lightning: 'Электричество', thunder: 'Гром',
}
const WEAPONS: Array<[string, string]> = [
  ['club', 'Дубинка'], ['dagger', 'Кинжал'], ['greatclub', 'Палица'], ['handaxe', 'Ручной топор'],
  ['javelin', 'Метательное копьё'], ['light_hammer', 'Лёгкий молот'], ['mace', 'Булава'], ['quarterstaff', 'Боевой посох'],
  ['sickle', 'Серп'], ['spear', 'Копьё'], ['light_crossbow', 'Лёгкий арбалет'], ['dart', 'Дротик'],
  ['shortbow', 'Короткий лук'], ['sling', 'Праща'], ['battleaxe', 'Боевой топор'], ['flail', 'Цеп'],
  ['glaive', 'Глефа'], ['greataxe', 'Секира'], ['greatsword', 'Двуручный меч'], ['halberd', 'Алебарда'],
  ['lance', 'Копьё всадника'], ['longsword', 'Длинный меч'], ['maul', 'Молот'], ['morningstar', 'Моргенштерн'],
  ['pike', 'Пика'], ['rapier', 'Рапира'], ['scimitar', 'Скимитар'], ['shortsword', 'Короткий меч'],
  ['trident', 'Трезубец'], ['war_pick', 'Военная кирка'], ['warhammer', 'Боевой молот'], ['whip', 'Кнут'],
  ['hand_crossbow', 'Ручной арбалет'], ['heavy_crossbow', 'Тяжёлый арбалет'], ['longbow', 'Длинный лук'],
  ['net', 'Сеть'], ['blowgun', 'Духовая трубка'],
]
const RANGER_ENEMIES: Array<[string, string]> = [
  ['aberrations', 'Аберрации'], ['beasts', 'Звери'], ['celestials', 'Небожители'], ['constructs', 'Конструкты'],
  ['dragons', 'Драконы'], ['elementals', 'Элементали'], ['fey', 'Феи'], ['fiends', 'Исчадия'],
  ['giants', 'Великаны'], ['humanoids', 'Гуманоиды'], ['monstrosities', 'Чудовища'], ['oozes', 'Слизни'],
  ['plants', 'Растения'], ['undead', 'Нежить'],
]
const RANGER_TERRAINS: Array<[string, string]> = [
  ['arctic', 'Арктика'], ['coast', 'Побережье'], ['desert', 'Пустыня'], ['forest', 'Лес'],
  ['grassland', 'Равнина'], ['mountain', 'Горы'], ['swamp', 'Болота'], ['underdark', 'Подземье'],
]
const DRACONIC_ANCESTRIES: Array<[string, string]> = [
  ['black', 'Чёрный'], ['blue', 'Синий'], ['brass', 'Латунный'], ['bronze', 'Бронзовый'], ['copper', 'Медный'],
  ['gold', 'Золотой'], ['green', 'Зелёный'], ['red', 'Красный'], ['silver', 'Серебряный'], ['white', 'Белый'],
]
const SPELL_SNIPER_CANTRIPS = new Set(['chill-touch', 'fire-bolt', 'ray-of-frost', 'shocking-grasp', 'produce-flame', 'thorn-whip', 'eldritch-blast'])
const MANEUVER_LABELS: Record<string, string> = {
  'commander-s-strike': 'Командирский удар', 'disarming-attack': 'Обезоруживающая атака', 'distracting-strike': 'Отвлекающий удар',
  'evasive-footwork': 'Уклоняющаяся работа ног', 'feinting-attack': 'Ложная атака', 'goading-attack': 'Провоцирующая атака',
  'lunging-attack': 'Выпад', 'maneuvering-attack': 'Маневрирующая атака', 'menacing-attack': 'Угрожающая атака',
  parry: 'Парирование', 'precision-attack': 'Точная атака', 'pushing-attack': 'Толкающая атака', rally: 'Воодушевление',
  riposte: 'Ответный удар', 'sweeping-attack': 'Размашистая атака', 'trip-attack': 'Опрокидывающая атака',
}
const SPELL_CLASSES = ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard']
const CLASS_ABILITY_LABELS: Record<string, string> = {
  bard: 'Харизма', cleric: 'Мудрость', druid: 'Мудрость', sorcerer: 'Харизма', warlock: 'Харизма', wizard: 'Интеллект',
}

const text = (value: unknown, fallback = '') => String(value ?? fallback)
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const idOf = (value: unknown) => typeof value === 'string' ? value : text(record(value).id)
const token = (value: unknown) => text(value).trim().toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[\s-]+/gu, '_')
const spellId = (value: unknown) => text(value).trim().toLocaleLowerCase('en').replace(/_/gu, '-')
const entryName = (entry: unknown, fallback = '') => {
  if (typeof entry === 'string') return fallback || entry
  const item = record(entry)
  return text(item.name ?? item.label ?? item.english_name ?? item.id, fallback)
}
const optionLabel = (id: string, entries: PhbCatalogEntry[], fallback = id) => entryName(entries.find((entry) => token(entry.id) === token(id)), fallback)
const selectedIds = (choices: PhbChoiceRecord, keys: string[]) => {
  for (const key of keys) if (Array.isArray(choices[key])) return (choices[key] as unknown[]).map(idOf).filter(Boolean)
  return []
}
const selectedValue = (choices: PhbChoiceRecord, keys: string[]) => {
  for (const key of keys) if (choices[key] !== undefined) return choices[key]
  return ''
}
const toggle = (selected: string[], id: string, maximum: number, combined: string[][] = []) => {
  if (selected.includes(id)) return selected.filter((entry) => entry !== id)
  const total = selected.length + combined.reduce((sum, group) => sum + group.length, 0)
  return total >= maximum ? selected : [...selected, id]
}

function classOptionFor(catalog: PhbCharacterOptionsCatalog, classId: string) {
  return catalog.classes.find((entry) => entry.id === classId) ?? catalog.classes.find((entry) => token(entry.id) === token(classId)) ?? null
}

function subclassOptionsFor(option: PhbClassCatalogEntry | null) {
  return (option?.subclass_options ?? option?.subclasses ?? []).filter(Boolean)
}

function findSubclass(option: PhbClassCatalogEntry | null, raw: unknown) {
  const needle = token(raw)
  return subclassOptionsFor(option).find((entry) => [entry.id, entry.label, ...(entry.aliases ?? [])].some((value) => token(value) === needle)) ?? null
}

function classToolOptions(option: PhbClassCatalogEntry | null, catalog: PhbCharacterOptionsCatalog) {
  return list(option?.tool_choice?.options).map((entry) => {
    const id = idOf(entry)
    return { id, label: optionLabel(id, catalog.tools) }
  }).filter((entry) => entry.id)
}

function knownSet(values: string[]) {
  return new Set(values.map(token))
}

function armorSet(option: PhbClassCatalogEntry | null) {
  return new Set((option?.armor_proficiencies ?? []).map((entry) => token(entry).replace(/_armor$/u, '') === 'shields' ? 'shield' : token(entry).replace(/_armor$/u, '')))
}

function featPrerequisiteStatus(feat: PhbFeatCatalogEntry, option: PhbClassCatalogEntry | null, abilities: Partial<Record<PhbAbilityId, number>>) {
  const armor = armorSet(option)
  const canCast = Boolean(option?.spellcasting)
  const failures = (feat.prerequisites ?? []).filter((prerequisite) => {
    const kind = text(prerequisite.kind ?? prerequisite.type)
    if (kind === 'ability') return Number(abilities[text(prerequisite.ability) as PhbAbilityId] ?? 10) < Number(prerequisite.minimum ?? prerequisite.minimum_score ?? 0)
    if (kind === 'ability_any') return !(list(prerequisite.abilities).some((ability) => Number(abilities[text(ability) as PhbAbilityId] ?? 10) >= Number(prerequisite.minimum ?? 0)))
    if (kind === 'spellcasting') return !canCast
    if (kind === 'proficiency') return text(prerequisite.category) === 'armor' && !armor.has(token(prerequisite.value).replace(/_armor$/u, ''))
    return false
  })
  return { available: failures.length === 0, failures }
}

function featChoiceLabel(key: string) {
  return ({ ability: 'Характеристика', class: 'Класс магии', cantrips: 'Заговоры', cantrip: 'Заговор с атакой', spell: 'Заклинание 1 уровня', rituals: 'Ритуалы', damage_type: 'Тип урона', languages: 'Языки', skills: 'Навыки', tools: 'Инструменты', weapons: 'Оружие', maneuvers: 'Боевые приёмы' } as Record<string, string>)[key] ?? key
}

export function PhbCharacterOptions({
  catalog,
  classId,
  subclass,
  abilities,
  knownSkillIds,
  knownToolIds,
  variantHuman,
  value,
  onChange,
}: PhbCharacterOptionsProps) {
  const option = classOptionFor(catalog, classId)
  const classChoices = value.classChoices ?? {}
  const currentSubclass = findSubclass(option, classChoices.subclass ?? subclass)
  const featSelection = value.feat
  const feat = catalog.feats.find((entry) => entry.id === featSelection?.id) ?? null
  const featChoices = featSelection?.choices ?? {}
  const [featSearch, setFeatSearch] = useState('')
  const knownSkills = knownSet(knownSkillIds)
  const knownTools = knownSet(knownToolIds)

  const updateClassChoices = (patch: PhbChoiceRecord) => onChange({
    schema_version: 1, classChoices: { ...classChoices, ...patch }, ...(featSelection ? { feat: featSelection } : {}),
  })
  const updateFeat = (id: string, choices: PhbChoiceRecord = {}) => onChange({
    schema_version: 1, classChoices: { ...classChoices }, feat: { id, choices },
  })
  const updateFeatChoices = (patch: PhbChoiceRecord) => {
    if (!featSelection) return
    updateFeat(featSelection.id, { ...featChoices, ...patch })
  }

  const renderSelection = ({
    title,
    options,
    selected,
    count,
    onToggle,
    disabled,
    name,
  }: {
    title: string
    options: Array<{ id: string; label: string }>
    selected: string[]
    count: number
    onToggle: (id: string) => void
    disabled?: (id: string) => boolean
    name: string
  }) => <fieldset className="creation-choice-group" key={name}>
    <legend>{title}</legend>
    <span aria-live="polite">{selected.length}/{count}</span>
    <div>
      {options.map((entry) => {
        const checked = selected.includes(entry.id)
        const isDisabled = !checked && (selected.length >= count || disabled?.(entry.id) === true)
        return <label key={entry.id}>
          <input type="checkbox" name={name} checked={checked} disabled={isDisabled} onChange={() => onToggle(entry.id)} />
          <span>{entry.label}</span>
        </label>
      })}
    </div>
  </fieldset>

  const renderClassChoices = () => {
    if (!option) return <p className="creation-empty">Класс не найден в каталоге PHB 2014.</p>
    const selectedSkills = selectedIds(classChoices, ['skills', 'class_skills', 'classSkillProficiencies', 'skill_proficiencies'])
    const toolOptions = classToolOptions(option, catalog)
    const toolChoice = option.tool_choice
    const expertiseChoice = option.choices?.find((entry) => entry.id === 'expertise')
    const selectedExpertise = selectedIds(classChoices, ['expertise'])
    const ownedForExpertise = new Set([...knownSkills, ...knownTools, ...selectedSkills.map(token), ...(option.tool_proficiencies ?? []).map(token)])
    const favored = record(classChoices.favored_enemy)
    const favoredType = text(favored.type)
    const favoredRaces = Array.isArray(favored.races) ? favored.races.map((value) => text(value)) : ['', '']
    const currentDomainChoices = currentSubclass?.choices ?? {}

    return <>
      {option.id === 'bard' && toolChoice && renderSelection({
        title: 'Музыкальные инструменты (3)', name: 'phb-bard-instruments', options: toolOptions, selected: selectedIds(classChoices, ['instruments']), count: 3,
        onToggle: (id) => updateClassChoices({ instruments: toggle(selectedIds(classChoices, ['instruments']), id, 3) }),
      })}
      {option.id === 'monk' && toolChoice && <section className="creation-choice-group">
        <header><span>Ремесленный инструмент или музыкальный инструмент</span></header>
        <div>
          {classToolOptions(option, catalog).map((entry) => {
            const chosen = record(classChoices.tool_or_instrument).id === entry.id
            const isArtisan = list(toolChoice.option_kinds?.artisan_tools).map(idOf).includes(entry.id)
            return <label key={entry.id}>
              <input type="radio" name="phb-monk-tool" checked={chosen} onChange={() => updateClassChoices({ tool_or_instrument: { kind: isArtisan ? 'artisan_tool' : 'musical_instrument', id: entry.id } })} />
              <span>{entry.label}</span>
            </label>
          })}
        </div>
      </section>}
      {option.id === 'rogue' && expertiseChoice && <>
        {renderSelection({
          title: 'Мастерство (2 уже известных владения)', name: 'phb-rogue-expertise',
          options: list(expertiseChoice.options).map((entry) => ({ id: idOf(entry), label: optionLabel(idOf(entry), catalog.skills, idOf(entry) === 'thieves_tools' ? 'Воровские инструменты' : idOf(entry)) })).filter((entry) => entry.id),
          selected: selectedExpertise, count: 2, disabled: (id) => !ownedForExpertise.has(token(id)),
          onToggle: (id) => updateClassChoices({ expertise: toggle(selectedExpertise, id, 2) }),
        })}
        <p className="creation-support-note">Мастерство выбирается только среди владений, полученных расой, предысторией или классом.</p>
      </>}
      {option.id === 'ranger' && <section className="creation-form">
        <label><span>Избранный враг</span><select value={favoredType} onChange={(event) => updateClassChoices({ favored_enemy: { type: event.target.value, races: event.target.value === 'humanoids' ? favoredRaces : [], language: text(favored.language) } })}>
          <option value="">Выберите тип</option>
          {RANGER_ENEMIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        {favoredType === 'humanoids' && <div className="creation-form">
          {[0, 1].map((index) => <label key={index}><span>Раса гуманоидов {index + 1}</span><input value={favoredRaces[index] ?? ''} onChange={(event) => updateClassChoices({ favored_enemy: { type: favoredType, races: favoredRaces.map((race, i) => i === index ? event.target.value : race), language: text(favored.language) } })} /></label>)}
        </div>}
        <label><span>Изучаемый язык</span><select value={text(favored.language)} onChange={(event) => updateClassChoices({ favored_enemy: { type: favoredType, races: favoredType === 'humanoids' ? favoredRaces : [], language: event.target.value } })}>
          <option value="">Выберите язык</option>{catalog.languages.map((entry) => <option key={entry.id} value={entry.id}>{entryName(entry)}</option>)}
        </select></label>
        <label><span>Предпочитаемая местность</span><select value={text(selectedValue(classChoices, ['natural_explorer', 'naturalExplorer']))} onChange={(event) => updateClassChoices({ natural_explorer: event.target.value })}>
          <option value="">Выберите местность</option>{RANGER_TERRAINS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
      </section>}
      {currentSubclass?.id === 'knowledge' && <>
        {renderSelection({
          title: 'Домен знаний: навыки', name: 'phb-knowledge-skills', options: list(currentDomainChoices.knowledge_skills?.options).map((entry) => ({ id: idOf(entry), label: optionLabel(idOf(entry), catalog.skills) })),
          selected: selectedIds(classChoices, ['knowledge_skills']), count: 2,
          onToggle: (id) => { const selected = selectedIds(classChoices, ['knowledge_skills']); updateClassChoices({ knowledge_skills: toggle(selected, id, 2) }) },
        })}
        {renderSelection({
          title: 'Домен знаний: языки', name: 'phb-knowledge-languages', options: catalog.languages.map((entry) => ({ id: entry.id, label: entryName(entry) })),
          selected: selectedIds(classChoices, ['knowledge_languages']), count: 2,
          onToggle: (id) => { const selected = selectedIds(classChoices, ['knowledge_languages']); updateClassChoices({ knowledge_languages: toggle(selected, id, 2) }) },
        })}
      </>}
      {currentSubclass?.id === 'nature' && <section className="creation-form">
        <label><span>Заговор друида</span><select value={text(selectedValue(classChoices, ['nature_cantrip', 'druid_cantrip']))} onChange={(event) => updateClassChoices({ nature_cantrip: event.target.value })}>
          <option value="">Выберите заговор</option>{list(currentDomainChoices.nature_cantrip?.options).map((entry) => <option key={idOf(entry)} value={idOf(entry)}>{optionLabel(idOf(entry), catalog.spells)}</option>)}
        </select></label>
        <label><span>Навык домена природы</span><select value={text(selectedValue(classChoices, ['nature_skill']))} onChange={(event) => updateClassChoices({ nature_skill: event.target.value })}>
          <option value="">Выберите навык</option>{list(currentDomainChoices.nature_skill?.options).map((entry) => <option key={idOf(entry)} value={idOf(entry)}>{optionLabel(idOf(entry), catalog.skills)}</option>)}
        </select></label>
      </section>}
      {currentSubclass?.id === 'draconic-bloodline' && <section className="creation-form">
        <label><span>Драконий предок</span><select value={text(selectedValue(classChoices, ['draconic_ancestry', 'ancestry']))} onChange={(event) => updateClassChoices({ draconic_ancestry: event.target.value })}>
          <option value="">Выберите цвет</option>{list(currentSubclass.choices?.draconic_ancestry?.options).map((entry) => <option key={idOf(entry)} value={idOf(entry)}>{DRACONIC_ANCESTRIES.find(([id]) => id === idOf(entry))?.[1] ?? idOf(entry)}</option>)}
        </select></label>
      </section>}
    </>
  }

  const featSpellOptions = (kind: string, chosenClass: string) => {
    const level = kind === 'cantrips' || kind === 'cantrip' ? 0 : 1
    const attackOnly = kind === 'cantrip'
    return catalog.spells.filter((spell) => spell.level === level
      && (spell.classes ?? []).some((entry) => token(entry) === token(chosenClass))
      && (!attackOnly || SPELL_SNIPER_CANTRIPS.has(spellId(spell.id))))
  }

  const renderFeatChoice = (featEntry: PhbFeatCatalogEntry, key: string, schema: PhbChoiceSchema) => {
    const current = selectedValue(featChoices, [key])
    const count = Number(schema.count ?? 1)
    const type = text(schema.type ?? schema.kind)
    const options = list(schema.options).map((entry) => idOf(entry)).filter(Boolean)
    if (type === 'ability') return <label className="creation-form" key={key}><span>{featChoiceLabel(key)}</span><select value={text(current)} onChange={(event) => updateFeatChoices({ [key]: event.target.value })}>
      <option value="">Выберите характеристику</option>{options.map((entry) => <option key={entry} value={entry}>{ABILITY_LABELS[entry as PhbAbilityId] ?? entry}</option>)}
    </select></label>
    if (type === 'spellcasting_class') return <label className="creation-form" key={key}><span>{featChoiceLabel(key)}</span><select value={text(current)} onChange={(event) => {
      const reset: PhbChoiceRecord = key === 'class' ? { class: event.target.value } : { [key]: event.target.value }
      if (featEntry.id === 'magic-initiate') Object.assign(reset, { cantrips: [], spell: '' })
      if (featEntry.id === 'ritual-caster') Object.assign(reset, { rituals: [] })
      if (featEntry.id === 'spell-sniper') Object.assign(reset, { cantrip: '' })
      updateFeatChoices(reset)
    }}>
      <option value="">Выберите класс</option>{options.map((entry) => <option key={entry} value={entry}>{catalog.classes.find((candidate) => candidate.id === entry)?.label ?? entry}</option>)}
    </select></label>
    if (type === 'damage_type') return <label className="creation-form" key={key}><span>{featChoiceLabel(key)}</span><select value={text(current)} onChange={(event) => updateFeatChoices({ [key]: event.target.value })}>
      <option value="">Выберите тип урона</option>{options.map((entry) => <option key={entry} value={entry}>{DAMAGE_LABELS[entry] ?? entry}</option>)}
    </select></label>
    if (type === 'maneuver') return renderSelection({
      title: `${featChoiceLabel(key)} (2)`, name: `phb-feat-${featEntry.id}-${key}`,
      options: options.map((entry) => ({ id: entry, label: MANEUVER_LABELS[entry] ?? entry })), selected: selectedIds(featChoices, [key]), count,
      onToggle: (id) => updateFeatChoices({ [key]: toggle(selectedIds(featChoices, [key]), id, count) }),
    })
    if (type === 'language') return renderSelection({
      title: featChoiceLabel(key), name: `phb-feat-${featEntry.id}-${key}`, options: catalog.languages.map((entry) => ({ id: entry.id, label: entryName(entry) })),
      selected: selectedIds(featChoices, [key]), count, onToggle: (id) => updateFeatChoices({ [key]: toggle(selectedIds(featChoices, [key]), id, count) }),
    })
    if (type === 'weapon') return renderSelection({
      title: featChoiceLabel(key), name: `phb-feat-${featEntry.id}-${key}`, options: WEAPONS.map(([id, label]) => ({ id, label })),
      selected: selectedIds(featChoices, [key]), count, onToggle: (id) => updateFeatChoices({ [key]: toggle(selectedIds(featChoices, [key]), id, count) }),
    })
    if (type === 'skill_or_tool') {
      const selectedSkills = selectedIds(featChoices, ['skills'])
      const selectedTools = selectedIds(featChoices, ['tools'])
      const total = selectedSkills.length + selectedTools.length
      const skillOptions = catalog.skills.map((entry) => ({ id: entry.id, label: entryName(entry) }))
      const toolOptions = catalog.tools.map((entry) => ({ id: entry.id, label: entryName(entry) }))
      return <div key={key}>
        <p aria-live="polite">Одарённый: {total}/3 владений</p>
        {key === 'skills' && renderSelection({ title: featChoiceLabel(key), name: `phb-feat-${featEntry.id}-skills`, options: skillOptions, selected: selectedSkills, count: 3, disabled: (id) => knownSkills.has(token(id)) || (total >= 3 && !selectedSkills.includes(id)), onToggle: (id) => updateFeatChoices({ skills: toggle(selectedSkills, id, 3, [selectedTools]) }) })}
        {key === 'tools' && renderSelection({ title: featChoiceLabel(key), name: `phb-feat-${featEntry.id}-tools`, options: toolOptions, selected: selectedTools, count: 3, disabled: (id) => knownTools.has(token(id)) || (total >= 3 && !selectedTools.includes(id)), onToggle: (id) => updateFeatChoices({ tools: toggle(selectedTools, id, 3, [selectedSkills]) }) })}
      </div>
    }
    if (type === 'cantrip' || type === 'first_level_spell' || type === 'first_level_ritual' || type === 'attack_roll_cantrip') {
      const chosenClass = text(selectedValue(featChoices, ['class', 'class_key', 'classKey']))
      const spellOptions = type === 'first_level_ritual'
        ? featSpellOptions('spell', chosenClass).filter((spell) => spell.ritual)
        : featSpellOptions(type === 'attack_roll_cantrip' ? 'cantrip' : type === 'cantrip' ? 'cantrips' : 'spell', chosenClass)
      if (count === 1) return <label className="creation-form" key={key}><span>{featChoiceLabel(key)}</span><select value={text(current)} onChange={(event) => updateFeatChoices({ [key]: spellId(event.target.value) })} disabled={!chosenClass}>
        <option value="">{chosenClass ? 'Выберите заклинание' : 'Сначала выберите класс'}</option>{spellOptions.map((spell) => <option key={spell.id} value={spellId(spell.id)}>{entryName(spell)}</option>)}
      </select></label>
      const selected = selectedIds(featChoices, [key]).map(spellId)
      return renderSelection({
        title: featChoiceLabel(key), name: `phb-feat-${featEntry.id}-${key}`, options: spellOptions.map((spell) => ({ id: spellId(spell.id), label: entryName(spell) })),
        selected, count, disabled: () => !chosenClass, onToggle: (id) => updateFeatChoices({ [key]: toggle(selected, id, count) }),
      })
    }
    return null
  }

  const renderFeats = () => {
    if (!variantHuman) return null
    const needle = featSearch.trim().toLocaleLowerCase('ru').replace(/ё/gu, 'е')
    const visibleFeats = catalog.feats.filter((entry) => !needle || [entry.name, entry.label, entry.english_name, entry.summary]
      .some((value) => text(value).toLocaleLowerCase('ru').replace(/ё/gu, 'е').includes(needle)))
    return <section className="phb-feats">
      <header><span>Черта вариативного человека</span><b>{feat ? feat.name ?? feat.label ?? feat.id : 'не выбрана'}</b></header>
      <p className="creation-form">Вариативный человек получает одну черту PHB 2014 на 1 уровне. Требования показаны на карточках и проверяются сервером.</p>
      {feat && <div className="phb-feat-current" role="status">
        <span>Выбрано сейчас</span>
        <strong>{feat.name ?? feat.label ?? feat.id}</strong>
        {feat.summary && <p>{feat.summary}</p>}
      </div>}
      <div className="phb-feat-filter">
        <label>
          <span>Найти черту</span>
          <input type="search" value={featSearch} onChange={(event) => setFeatSearch(event.target.value)} placeholder="Название на русском, English или описание" aria-label="Поиск черты" />
        </label>
        <span className="phb-feat-filter-count" aria-live="polite">Найдено: {visibleFeats.length} из {catalog.feats.length}</span>
      </div>
      {visibleFeats.length > 0 ? <div className="creation-card-grid phb-feat-grid">
        {visibleFeats.map((entry) => {
          const status = featPrerequisiteStatus(entry, option, abilities)
          const checked = entry.id === featSelection?.id
          const name = entry.name ?? entry.label ?? entry.id
          const requirementText = (entry.prerequisites ?? []).length > 0
            ? status.available
              ? 'Требования выполнены'
              : `Требуется: ${(status.failures.length ? status.failures : (entry.prerequisites ?? [])).map((prerequisite) => text(prerequisite.label ?? prerequisite.description ?? prerequisite.value ?? prerequisite.kind)).join('; ')}`
            : ''
          return <label key={entry.id} className={`phb-feat-card ${checked ? 'selected' : ''} ${!status.available ? 'disabled' : ''}`}>
            <input type="radio" name="phb-feat" value={entry.id} checked={checked} disabled={!status.available} onChange={() => updateFeat(entry.id, {})} />
            <span className="phb-feat-card-body">
              <span className="phb-feat-card-heading">
                <strong>{name}</strong>
                {entry.english_name && <small className="phb-feat-card-english">{entry.english_name}</small>}
              </span>
              {entry.summary && <span className="phb-feat-card-summary">{entry.summary}</span>}
              {requirementText && <span className={`phb-feat-card-requirement ${status.available ? 'met' : 'unmet'}`}>{requirementText}</span>}
              {entry.mechanics_status === 'partial' && <span className="phb-feat-card-support">Механика применяется частично; выбор сохраняется на листе.</span>}
            </span>
          </label>
        })}
      </div> : <p className="phb-feat-empty" role="status">По запросу «{featSearch.trim()}» ничего не найдено. Попробуйте другое слово или очистите поиск.</p>}
      {feat && <div className="creation-form">
        <h3>Выборы черты: {feat.name ?? feat.label ?? feat.id}</h3>
        {Object.entries(feat.choice_schema ?? {}).map(([key, schema]) => renderFeatChoice(feat, key, schema ?? {}))}
      </div>}
    </section>
  }

  return <div className="creation-choices phb-character-options">
    <section><header><span>Класс: {option?.label ?? option?.name ?? classId}</span><b>1 уровень</b></header></section>
    {renderClassChoices()}
    {renderFeats()}
  </div>
}
