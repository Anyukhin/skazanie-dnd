import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Backpack, Check, Coins, Download, FileJson, ImagePlus, LockKeyhole, Maximize2, PackageOpen,
  Pencil, Plus, Save, Search, Shield, Sparkles, Trash2, Upload, Weight, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { generateItemImage } from './ai-client'
import { DND_CLASS_OPTIONS, classFeatureCatalogFor, playerClassKey, subclassOptionsFor } from './combat-actions'
import { fallbackCombatSpells, spellSelectionRules } from './combat-spells'
import { classSkillRulesFor, featureChoiceGroupsFor, normalizedSelectedFeatures } from './character-progression'
import { itemImageFor } from './item-images'
import type { FeatureChoiceGroup } from './character-progression'
import type { InventoryItem, Player } from './types'

const abilityNames: Record<keyof Player['abilities'], string> = { str: 'СИЛ', dex: 'ЛОВ', con: 'ТЕЛ', int: 'ИНТ', wis: 'МДР', cha: 'ХАР' }
const itemTypeNames: Record<InventoryItem['type'], string> = { weapon: 'Оружие', armor: 'Доспех', consumable: 'Расходник', tool: 'Инструмент', quest: 'Задание', treasure: 'Сокровище', document: 'Документ', other: 'Прочее' }

function defaultWeaponCombat(): NonNullable<InventoryItem['combat']> {
  return { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'slashing', normalRange: 5 }
}

function modifier(score: number) {
  const value = Math.floor((score - 10) / 2)
  return value >= 0 ? `+${value}` : String(value)
}

function Field({ label, value, onChange, type = 'text', min, max, readOnly = false }: { label: string; value: string | number; onChange: (value: string) => void; type?: string; min?: number; max?: number; readOnly?: boolean }) {
  return <label className="sheet-field"><span>{label}</span><input type={type} min={min} max={max} value={value} readOnly={readOnly} aria-readonly={readOnly} onChange={(event) => onChange(event.target.value)} /></label>
}

function TextField({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  return <label className="sheet-field textarea-field"><span>{label}</span><textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} /></label>
}

export function CharacterEditor({ player, onClose, onSave, onImport, onLevelUp }: { player: Player; onClose: () => void; onSave: (patch: Partial<Player>) => void; onImport: (source: string) => Promise<void>; onLevelUp: () => void }) {
  const [draft, setDraft] = useState<Player>(() => structuredClone(player))
  const [tab, setTab] = useState<'sheet' | 'story' | 'advancement'>('sheet')
  const [notice, setNotice] = useState('')
  const [developmentSearch, setDevelopmentSearch] = useState('')
  const [spellLevelFilter, setSpellLevelFilter] = useState<number | 'all'>('all')
  const avatarInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(structuredClone(player)), [player])
  const patch = <K extends keyof Player>(key: K, value: Player[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const classKey = playerClassKey(draft)
  const classOption = DND_CLASS_OPTIONS.find((entry) => entry.key === classKey)
  const subclasses = subclassOptionsFor(draft)
  const subclassUnlocked = Boolean(classOption && draft.level >= classOption.subclassLevel)
  const spellRules = spellSelectionRules(draft)
  const classSkillRules = classSkillRulesFor(draft)
  const selectedClassSkills = draft.classSkillProficiencies ?? []
  const featureChoiceGroups = featureChoiceGroupsFor(draft)
  const selectedFeatureIds = draft.selectedFeatureIds ?? []
  const developmentSpells = fallbackCombatSpells(draft)
  const knownSpellIds = draft.knownSpellIds ?? []
  const preparedSpellIds = draft.preparedSpellIds ?? []
  const knownCantrips = developmentSpells.filter((spell) => spell.level === 0 && knownSpellIds.includes(spell.id)).length
  const knownLeveled = developmentSpells.filter((spell) => spell.level > 0 && knownSpellIds.includes(spell.id)).length
  const preparedLeveled = developmentSpells.filter((spell) => spell.level > 0 && preparedSpellIds.includes(spell.id)).length
  const developmentQuery = developmentSearch.trim().toLocaleLowerCase('ru')
  const filteredClassSkills = (classSkillRules?.options ?? []).filter((skill) => !developmentQuery || `${skill.name} ${skill.ability}`.toLocaleLowerCase('ru').includes(developmentQuery))
  const filteredFeatureChoiceGroups = featureChoiceGroups.map((group) => ({
    ...group,
    options: group.options.filter((option) => !developmentQuery || `${group.name} ${option.name}`.toLocaleLowerCase('ru').includes(developmentQuery)),
  })).filter((group) => group.options.length > 0)
  const developmentFeatures = classFeatureCatalogFor(draft, true).filter((feature) => !developmentQuery || `${feature.name} ${feature.description} ${feature.subclass ?? ''}`.toLocaleLowerCase('ru').includes(developmentQuery))
  const filteredDevelopmentSpells = developmentSpells.filter((spell) => (spellLevelFilter === 'all' || spell.level === spellLevelFilter) && (!developmentQuery || `${spell.name} ${spell.englishName ?? ''} ${spell.description ?? ''}`.toLocaleLowerCase('ru').includes(developmentQuery)))
  const skillsValid = !Object.hasOwn(draft, 'classSkillProficiencies') || !classSkillRules || selectedClassSkills.length === classSkillRules.choiceCount
  const featureChoicesRequired = Object.hasOwn(draft, 'selectedFeatureIds') || draft.level > player.level
  const featureChoicesValid = !featureChoicesRequired || featureChoiceGroups.every((group) => group.options.filter((option) => selectedFeatureIds.includes(option.id)).length === group.choiceCount)
  const subclassValid = !subclassUnlocked || Boolean(draft.subclass)
  const developmentValid = subclassValid && skillsValid && featureChoicesValid && (!spellRules || (knownCantrips <= spellRules.cantrips
    && (spellRules.mode !== 'known' || knownLeveled <= spellRules.spellsKnown)
    && (spellRules.mode !== 'spellbook' || knownLeveled <= Math.max(spellRules.spellbookMinimum, player.knownSpellIds?.length ?? 0))
    && preparedLeveled <= spellRules.preparedLimit))

  useEffect(() => {
    if (!subclassUnlocked && draft.subclass) setDraft((current) => ({ ...current, subclass: undefined }))
  }, [draft.subclass, subclassUnlocked])

  const toggleSpellId = (key: 'knownSpellIds' | 'preparedSpellIds', spellId: string, maximum: number, categoryIds: string[]) => {
    const current = draft[key] ?? []
    const selected = current.includes(spellId)
    if (!selected && categoryIds.length >= maximum) {
      setNotice(`Достигнут лимит по правилам класса: ${maximum}. Сначала снимите другой выбор.`)
      return
    }
    patch(key, selected ? current.filter((id) => id !== spellId) : [...current, spellId])
    setNotice('')
  }

  const toggleDevelopmentSpell = (spellId: string, prepare = false) => {
    if (!spellRules) return
    const spell = developmentSpells.find((entry) => entry.id === spellId)
    if (!spell) return
    if (spell.level === 0) {
      toggleSpellId('knownSpellIds', spellId, spellRules.cantrips, developmentSpells.filter((entry) => entry.level === 0 && knownSpellIds.includes(entry.id)).map((entry) => entry.id))
      return
    }
    if (spellRules.mode === 'known') {
      toggleSpellId('knownSpellIds', spellId, spellRules.spellsKnown, developmentSpells.filter((entry) => entry.level > 0 && knownSpellIds.includes(entry.id)).map((entry) => entry.id))
      return
    }
    if (spellRules.mode === 'spellbook' && !prepare) {
      const maximum = Math.max(spellRules.spellbookMinimum, player.knownSpellIds?.length ?? 0)
      toggleSpellId('knownSpellIds', spellId, maximum, developmentSpells.filter((entry) => entry.level > 0 && knownSpellIds.includes(entry.id)).map((entry) => entry.id))
      if (knownSpellIds.includes(spellId)) patch('preparedSpellIds', preparedSpellIds.filter((id) => id !== spellId))
      return
    }
    if (spellRules.mode === 'spellbook' && !knownSpellIds.includes(spellId)) {
      setNotice('Сначала добавьте заклинание в книгу волшебника.')
      return
    }
    toggleSpellId('preparedSpellIds', spellId, spellRules.preparedLimit, developmentSpells.filter((entry) => entry.level > 0 && preparedSpellIds.includes(entry.id)).map((entry) => entry.id))
  }

  const toggleClassSkill = (skillId: string) => {
    if (!classSkillRules) return
    const selected = selectedClassSkills.includes(skillId)
    if (!selected && selectedClassSkills.length >= classSkillRules.choiceCount) {
      setNotice(`Класс ${classOption?.label ?? ''} позволяет выбрать ${classSkillRules.choiceCount} навыка. Сначала снимите другой выбор.`)
      return
    }
    patch('classSkillProficiencies', selected ? selectedClassSkills.filter((id) => id !== skillId) : [...selectedClassSkills, skillId])
    setNotice('')
  }

  const toggleFeatureChoice = (group: FeatureChoiceGroup & { choiceCount: number }, optionId: string) => {
    const current = draft.selectedFeatureIds ?? []
    const groupIds = new Set(group.options.map((option) => option.id))
    const chosenInGroup = current.filter((id) => groupIds.has(id))
    const selected = chosenInGroup.includes(optionId)
    if (!selected && chosenInGroup.length >= group.choiceCount) {
      setNotice(`${group.name}: можно выбрать ${group.choiceCount}. Сначала снимите другой выбор.`)
      return
    }
    patch('selectedFeatureIds', selected ? current.filter((id) => id !== optionId) : [...current, optionId])
    setNotice('')
  }

  const uploadAvatar = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return setNotice('Выберите изображение PNG, JPEG или WebP.')
    if (file.size > 2_000_000) return setNotice('Изображение должно быть меньше 2 МБ.')
    const reader = new FileReader()
    reader.onload = () => setDraft((current) => ({ ...current, portrait: String(reader.result), portraitPosition: 'center' }))
    reader.readAsDataURL(file)
  }

  const importSheet = async (file?: File) => {
    if (!file) return
    try {
      await onImport(await file.text())
      setNotice('Документ отправлен на серверную проверку и импорт.')
    } catch (error) {
      setNotice(error instanceof Error ? `Не удалось импортировать: ${error.message}` : 'Не удалось импортировать JSON.')
    }
  }

  const exportSheet = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(blob)
    anchor.download = `${draft.character || 'character'}-skazanie.json`
    anchor.click()
    URL.revokeObjectURL(anchor.href)
  }

  return (
    <div className="sheet-overlay" onMouseDown={onClose}>
      <section className="character-editor" role="dialog" aria-modal="true" aria-label={`Лист персонажа: ${draft.character}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="editor-head">
          <div className="editor-avatar" style={{ backgroundImage: `url(${draft.portrait})`, backgroundPosition: draft.portraitPosition }}>
            <button onClick={() => avatarInput.current?.click()}><ImagePlus size={17} />Сменить фото</button>
            <input ref={avatarInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => uploadAvatar(event.target.files?.[0])} />
          </div>
          <div><span>ЛИСТ ПЕРСОНАЖА</span><h2>{draft.character}</h2><p>{draft.role}</p></div>
          <div className="editor-actions">
            <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => importSheet(event.target.files?.[0])} />
            <button onClick={() => importInput.current?.click()}><Upload size={15} />Импорт Skazanie JSON</button>
            <button onClick={exportSheet}><Download size={15} />Экспорт</button>
            <button className="close-editor" onClick={onClose} aria-label="Закрыть лист персонажа"><X size={20} /></button>
          </div>
        </header>
        <nav className="editor-tabs"><button className={tab === 'sheet' ? 'active' : ''} onClick={() => setTab('sheet')}>Основной лист</button><button className={tab === 'story' ? 'active' : ''} onClick={() => setTab('story')}>История и особенности</button><button className={tab === 'advancement' ? 'active' : ''} onClick={() => setTab('advancement')}><Sparkles size={14} />Развитие</button><button onClick={onLevelUp}><Sparkles size={14} />Повысить уровень</button><span><Backpack size={14} />{draft.inventory.length} предметов</span></nav>
        <div className="editor-content">
          {tab === 'sheet' ? <>
            <div className="sheet-section identity-grid">
              <Field label="Имя персонажа" value={draft.character} onChange={(value) => patch('character', value)} />
              <Field label="Имя игрока" value={draft.name} onChange={(value) => patch('name', value)} />
              <label className="sheet-field"><span>Класс · задаётся сервером</span><select value={classKey ?? ''} disabled onChange={(event) => {
                const next = DND_CLASS_OPTIONS.find((entry) => entry.key === event.target.value)
                setDraft((current) => ({
                  ...current,
                  characterClass: next?.key,
                  role: next ? `${next.label} · ур. ${current.level}` : current.role,
                  subclass: undefined,
                  selectedFeatureIds: [],
                  classSkillProficiencies: [],
                  knownSpellIds: [],
                  preparedSpellIds: [],
                }))
              }}><option value="">Выберите класс</option>{DND_CLASS_OPTIONS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
              <label className="sheet-field"><span>Подкласс{classOption ? ` · с ${classOption.subclassLevel} ур.` : ''}</span><select value={draft.subclass ?? ''} disabled={!subclassUnlocked} onChange={(event) => {
                const nextSubclass = event.target.value || undefined
                setDraft((current) => {
                  const next = { ...current, subclass: nextSubclass }
                  return { ...next, selectedFeatureIds: normalizedSelectedFeatures(next) }
                })
              }}><option value="">{subclassUnlocked ? 'Выберите подкласс' : 'Ещё не открыт'}</option>{subclasses.map((entry) => <option key={entry.id} value={entry.name}>{entry.name}</option>)}</select></label>
              <Field label="Раса / вид" value={draft.species} onChange={(value) => patch('species', value)} />
              <Field label="Предыстория" value={draft.background} onChange={(value) => patch('background', value)} />
              <Field label="Мировоззрение" value={draft.alignment} onChange={(value) => patch('alignment', value)} />
            </div>
            <div className="ability-editor">
              {(Object.keys(abilityNames) as Array<keyof Player['abilities']>).map((key) => <label key={key}><span>{abilityNames[key]}</span><input type="number" min="1" max="30" value={draft.abilities[key]} readOnly aria-readonly="true" /><b>{modifier(draft.abilities[key])}</b></label>)}
            </div>
            <div className="sheet-section combat-grid">
              <Field label="Уровень · сервер" type="number" min={1} max={12} value={draft.level} readOnly onChange={(value) => {
                const level = Math.max(1, Math.min(12, Number(value) || 1))
                setDraft((current) => ({ ...current, level, role: classOption ? `${classOption.label} · ур. ${level}` : current.role }))
              }} />
              <Field label="Опыт · сервер" type="number" min={0} value={draft.experience} readOnly onChange={(value) => patch('experience', Number(value))} />
              <Field label="Текущие хиты · сервер" type="number" min={0} value={draft.hp} readOnly onChange={(value) => patch('hp', Number(value))} />
              <Field label="Максимум хитов · сервер" type="number" min={1} value={draft.maxHp} readOnly onChange={(value) => patch('maxHp', Number(value))} />
              <Field label="Класс брони · сервер" type="number" min={0} value={draft.armor} readOnly onChange={(value) => patch('armor', Number(value))} />
              <Field label="Скорость · сервер" type="number" min={0} value={draft.speed} readOnly onChange={(value) => patch('speed', Number(value))} />
              <Field label="Бонус мастерства · сервер" type="number" min={0} value={draft.proficiency} readOnly onChange={(value) => patch('proficiency', Number(value))} />
            </div>
            <div className="currency-editor"><span><Coins size={16} />МОНЕТЫ · СЕРВЕР</span>{(['copper', 'silver', 'gold', 'platinum'] as const).map((key) => <Field key={key} label={{ copper: 'Медь', silver: 'Серебро', gold: 'Золото', platinum: 'Платина' }[key]} type="number" min={0} value={draft.currency[key]} readOnly onChange={(value) => patch('currency', { ...draft.currency, [key]: Number(value) })} />)}</div>
          </> : tab === 'story' ? <div className="story-editor-grid">
            <TextField label="Предыстория" value={draft.backstory} onChange={(value) => patch('backstory', value)} rows={7} />
            <TextField label="Черты характера" value={draft.traits} onChange={(value) => patch('traits', value)} />
            <TextField label="Идеалы" value={draft.ideals} onChange={(value) => patch('ideals', value)} />
            <TextField label="Привязанности" value={draft.bonds} onChange={(value) => patch('bonds', value)} />
            <TextField label="Слабости" value={draft.flaws} onChange={(value) => patch('flaws', value)} />
            <TextField label="Умения и особенности" value={draft.features} onChange={(value) => patch('features', value)} rows={6} />
            <TextField label="Заметки" value={draft.notes} onChange={(value) => patch('notes', value)} rows={5} />
          </div> : <div className="advancement-editor">
            <section className="advancement-summary">
              <div><Sparkles size={20} /><span><small>{draft.level > player.level ? 'ПОВЫШЕНИЕ УРОВНЯ' : 'КОНСТРУКТОР ПЕРСОНАЖА'}</small><strong>{classOption?.label ?? 'Сначала выберите класс'} · {draft.level} уровень</strong></span></div>
              {classOption && <p>{subclassUnlocked ? draft.subclass ? `Подкласс: ${draft.subclass}` : 'На этом уровне нужно выбрать подкласс.' : `Подкласс откроется на ${classOption.subclassLevel}-м уровне.`}</p>}
            </section>
            <label className="advancement-search"><Search size={16} /><input value={developmentSearch} onChange={(event) => setDevelopmentSearch(event.target.value)} placeholder="Поиск навыка, умения или заклинания…" /></label>
            <section className="advancement-block skill-development">
              <header><div><Check size={17} /><span><strong>Владение навыками</strong><small>Классовый выбор первого уровня</small></span></div>{classSkillRules && <b className={selectedClassSkills.length !== classSkillRules.choiceCount ? 'invalid' : ''}>{selectedClassSkills.length}/{classSkillRules.choiceCount}</b>}</header>
              {classSkillRules ? <div className="class-skill-list">{filteredClassSkills.map((skill) => {
                const selected = selectedClassSkills.includes(skill.id)
                return <button key={skill.id} className={selected ? 'selected' : ''} onClick={() => toggleClassSkill(skill.id)}><i>{selected ? <Check size={14} /> : <Plus size={14} />}</i><span><strong>{skill.name}</strong><small>{skill.ability.toUpperCase()}</small></span></button>
              })}</div> : <p className="advancement-empty">Выберите класс, чтобы открыть допустимые навыки.</p>}
            </section>
            {featureChoiceGroups.length > 0 && <section className="advancement-block feature-choice-development">
              <header><div><Sparkles size={17} /><span><strong>Выбор классовых умений</strong><small>Новые варианты появляются на нужном уровне</small></span></div><b className={!featureChoicesValid ? 'invalid' : ''}>{featureChoiceGroups.reduce((sum, group) => sum + group.options.filter((option) => selectedFeatureIds.includes(option.id)).length, 0)}/{featureChoiceGroups.reduce((sum, group) => sum + group.choiceCount, 0)}</b></header>
              <div className="feature-choice-groups">{filteredFeatureChoiceGroups.map((group) => {
                const chosen = group.options.filter((option) => selectedFeatureIds.includes(option.id)).length
                return <section key={group.id}><header><span><strong>{group.name}</strong><small>Открыто на {group.unlockLevel} уровне</small></span><b className={chosen !== group.choiceCount ? 'invalid' : ''}>{chosen}/{group.choiceCount}</b></header><div>{group.options.map((option) => {
                  const selected = selectedFeatureIds.includes(option.id)
                  return <button key={option.id} className={selected ? 'selected' : ''} onClick={() => toggleFeatureChoice(group, option.id)}><i>{selected ? <Check size={14} /> : <Plus size={14} />}</i><span><strong>{option.name}</strong>{option.minimumLevel && <small>с {option.minimumLevel} уровня</small>}</span></button>
                })}</div></section>
              })}</div>
            </section>}
            <section className="advancement-block">
              <header><div><Shield size={17} /><span><strong>Классовые умения</strong><small>Автоматически открываются на требуемом уровне</small></span></div><b>{developmentFeatures.filter((feature) => draft.level >= Number(feature.minimumLevel ?? 1)).length}</b></header>
              <div className="feature-progression-list">{developmentFeatures.length ? developmentFeatures.map((feature) => {
                const unlocked = draft.level >= Number(feature.minimumLevel ?? 1)
                return <article key={feature.id} className={unlocked ? 'unlocked' : 'locked'}><i>{unlocked ? <Check size={14} /> : <LockKeyhole size={14} />}</i><span><strong>{feature.name}</strong><small>{feature.subclass || classOption?.label} · {feature.minimumLevel ?? 1} уровень</small><p>{feature.description}</p></span></article>
              }) : <p className="advancement-empty">Выберите класс и подкласс, чтобы увидеть развитие умений.</p>}</div>
            </section>
            <section className="advancement-block spell-development">
              <header><div><Sparkles size={17} /><span><strong>Заклинания</strong><small>{spellRules ? spellRules.mode === 'known' ? 'Известные заклинания' : spellRules.mode === 'spellbook' ? 'Книга и подготовка' : 'Подготовка после отдыха' : 'Этот класс не использует заклинания'}</small></span></div>{spellRules && <b>до {spellRules.maximumSpellLevel} круга</b>}</header>
              {spellRules ? <>
                <div className="spell-choice-counters">
                  {spellRules.cantrips > 0 && <span className={knownCantrips > spellRules.cantrips ? 'invalid' : ''}>Заговоры <b>{knownCantrips}/{spellRules.cantrips}</b></span>}
                  {spellRules.mode === 'known' && <span className={knownLeveled > spellRules.spellsKnown ? 'invalid' : ''}>Известно <b>{knownLeveled}/{spellRules.spellsKnown}</b></span>}
                  {spellRules.mode === 'spellbook' && <span className={knownLeveled > Math.max(spellRules.spellbookMinimum, player.knownSpellIds?.length ?? 0) ? 'invalid' : ''}>В книге <b>{knownLeveled}/{Math.max(spellRules.spellbookMinimum, player.knownSpellIds?.length ?? 0)}</b></span>}
                  {(spellRules.mode === 'prepared' || spellRules.mode === 'spellbook') && <span className={preparedLeveled > spellRules.preparedLimit ? 'invalid' : ''}>Подготовлено <b>{preparedLeveled}/{spellRules.preparedLimit}</b></span>}
                </div>
                <nav className="advancement-level-filter"><button className={spellLevelFilter === 'all' ? 'active' : ''} onClick={() => setSpellLevelFilter('all')}>Все</button>{[...new Set(developmentSpells.map((spell) => spell.level))].sort((a, b) => a - b).map((level) => <button key={level} className={spellLevelFilter === level ? 'active' : ''} onClick={() => setSpellLevelFilter(level)}>{level === 0 ? 'З' : level}</button>)}</nav>
                <div className="development-spell-list">{filteredDevelopmentSpells.map((spell) => {
                  const known = knownSpellIds.includes(spell.id)
                  const prepared = preparedSpellIds.includes(spell.id)
                  return <article key={spell.id} className={known || prepared ? 'selected' : ''}><span><strong>{spell.name}</strong><small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spell.castingTime || '1 действие'} · {spell.rangeText || `${spell.range} фт.`}</small><p>{spell.description}</p></span><div>
                    {spell.level === 0 || spellRules.mode === 'known' ? <button className={known ? 'active' : ''} onClick={() => toggleDevelopmentSpell(spell.id)}>{known ? <Check size={13} /> : <Plus size={13} />}{spell.level === 0 ? 'Изучен' : 'Выбрать'}</button> : spellRules.mode === 'spellbook' ? <><button className={known ? 'active' : ''} onClick={() => toggleDevelopmentSpell(spell.id)}>{known ? <Check size={13} /> : <Plus size={13} />}Книга</button><button className={prepared ? 'active' : ''} disabled={!known} onClick={() => toggleDevelopmentSpell(spell.id, true)}>{prepared ? <Check size={13} /> : <Plus size={13} />}Подготовить</button></> : <button className={prepared ? 'active' : ''} onClick={() => toggleDevelopmentSpell(spell.id, true)}>{prepared ? <Check size={13} /> : <Plus size={13} />}Подготовить</button>}
                  </div></article>
                })}</div>
              </> : <p className="advancement-empty">Заклинания появятся здесь автоматически, если выбран класс-заклинатель и достигнут нужный уровень.</p>}
            </section>
          </div>}
        </div>
        <footer className="editor-footer"><p>{notice || (developmentValid ? 'Изменения сохраняются в общей сессии и сразу видны отряду.' : 'Не завершён обязательный выбор подкласса, навыков, умений или превышен лимит заклинаний.')}</p><button onClick={() => { if (!developmentValid) { setTab('advancement'); setNotice('Завершите обязательный выбор подкласса, навыков и классовых умений; исправьте превышенные лимиты заклинаний.'); return } const sanitized = { ...draft, selectedFeatureIds: normalizedSelectedFeatures(draft) }; onClose(); onSave(sanitized) }}><Save size={16} />Сохранить персонажа</button></footer>
      </section>
    </div>
  )
}

function ItemImage({ item, zoom = 1 }: { item: InventoryItem; zoom?: number }) {
  const image = itemImageFor(item)
  if (!image) return <div className="item-image-placeholder" role="img" aria-label={`Предмет: ${item.name}`}><PackageOpen size={27} /></div>
  if (image.includes('item-atlas')) return <div className="item-atlas-crop" role="img" aria-label={item.name} style={{ backgroundImage: `url(${image})`, backgroundPosition: item.imagePosition ?? '0% 0%', transform: `scale(${zoom})` }} />
  return <img src={image} alt={item.name} style={{ objectPosition: item.imagePosition ?? 'center', transform: `scale(${zoom})` }} />
}

function ItemModal({ item, isNew, onClose, onSave, onRemove }: { item: InventoryItem; isNew: boolean; onClose: () => void; onSave: (item: InventoryItem) => void; onRemove: (id: string) => void }) {
  const [draft, setDraft] = useState<InventoryItem>(() => structuredClone(item))
  const [editing, setEditing] = useState(isNew)
  const [zoom, setZoom] = useState(1)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const patch = <K extends keyof InventoryItem>(key: K, value: InventoryItem[K]) => setDraft((current) => ({ ...current, [key]: value }))

  const createImage = async () => {
    if (!draft.imagePrompt?.trim()) return setError('Сначала добавьте промпт изображения в режиме редактирования.')
    setGenerating(true); setError('')
    try {
      const landscape = draft.type === 'document' && /карт|map|схем|план/i.test(`${draft.name} ${draft.description}`)
      const result = await generateItemImage(draft.imagePrompt, landscape)
      const next = { ...draft, image: result.url, imageStatus: 'ready' as const }
      setDraft(next); onSave(next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ошибка генерации') }
    finally { setGenerating(false) }
  }

  return <div className="item-modal-backdrop" onMouseDown={onClose}><section className="item-modal" role="dialog" aria-modal="true" aria-label={isNew ? 'Создание предмета' : `Предмет: ${draft.name}`} onMouseDown={(event) => event.stopPropagation()}>
    <button className="item-modal-close" onClick={onClose} aria-label="Закрыть предмет"><X size={20} /></button>
    <div className={`item-hero ${draft.type === 'document' ? 'landscape' : ''}`}><ItemImage item={draft} zoom={zoom} />
      {itemImageFor(draft) && <div className="item-zoom"><button onClick={() => setZoom((value) => Math.max(1, value - .25))}><ZoomOut size={16} /></button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(3, value + .25))}><ZoomIn size={16} /></button></div>}
    </div>
    <div className="item-modal-body">
      {editing ? <div className="item-form">
        <Field label="Название" value={draft.name} onChange={(value) => patch('name', value)} />
        <label className="sheet-field"><span>Тип</span><select value={draft.type} onChange={(event) => {
          const type = event.target.value as InventoryItem['type']
          setDraft((current) => ({ ...current, type, ...(type === 'weapon' && !current.combat ? { combat: defaultWeaponCombat() } : {}) }))
        }}>{Object.entries(itemTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="sheet-field"><span>Редкость</span><select value={draft.rarity} onChange={(event) => patch('rarity', event.target.value as InventoryItem['rarity'])}>{['обычный','необычный','редкий','очень редкий','легендарный','сюжетный'].map((value) => <option key={value}>{value}</option>)}</select></label>
        <Field label="Количество" type="number" min={1} value={draft.quantity} onChange={(value) => patch('quantity', Number(value))} />
        <Field label="Вес" type="number" min={0} value={draft.weight} onChange={(value) => patch('weight', Number(value))} />
        <TextField label="Описание" value={draft.description} onChange={(value) => patch('description', value)} rows={5} />
        <TextField label="Свойства" value={draft.properties} onChange={(value) => patch('properties', value)} rows={3} />
        {draft.type === 'weapon' && <div className="sheet-section combat-grid">
          <label className="sheet-field"><span>Тип атаки</span><select value={(draft.combat ?? defaultWeaponCombat()).kind} onChange={(event) => patch('combat', { ...(draft.combat ?? defaultWeaponCombat()), kind: event.target.value as NonNullable<InventoryItem['combat']>['kind'] })}><option value="melee">Ближний бой</option><option value="ranged">Дальний бой</option><option value="thrown-area">Бросок по области</option></select></label>
          <label className="sheet-field"><span>Характеристика</span><select value={(draft.combat ?? defaultWeaponCombat()).ability ?? 'str'} onChange={(event) => patch('combat', { ...(draft.combat ?? defaultWeaponCombat()), ability: event.target.value as 'str' | 'dex' })}><option value="str">Сила</option><option value="dex">Ловкость</option></select></label>
          <Field label="Кость урона" value={(draft.combat ?? defaultWeaponCombat()).damage} onChange={(value) => patch('combat', { ...(draft.combat ?? defaultWeaponCombat()), damage: value })} />
          <Field label="Тип урона" value={(draft.combat ?? defaultWeaponCombat()).damageType} onChange={(value) => patch('combat', { ...(draft.combat ?? defaultWeaponCombat()), damageType: value })} />
          <Field label="Обычная дальность, фт" type="number" min={5} value={(draft.combat ?? defaultWeaponCombat()).normalRange} onChange={(value) => patch('combat', { ...(draft.combat ?? defaultWeaponCombat()), normalRange: Math.max(5, Number(value) || 5) })} />
          {(draft.combat ?? defaultWeaponCombat()).kind === 'ranged' && <Field label="Макс. дальность, фт" type="number" min={5} value={(draft.combat ?? defaultWeaponCombat()).longRange ?? (draft.combat ?? defaultWeaponCombat()).normalRange} onChange={(value) => patch('combat', { ...(draft.combat ?? defaultWeaponCombat()), longRange: Math.max(5, Number(value) || 5) })} />}
        </div>}
        <TextField label="Промпт изображения" value={draft.imagePrompt ?? ''} onChange={(value) => patch('imagePrompt', value)} rows={4} />
        <label className="equipped-check"><input type="checkbox" checked={draft.equipped} onChange={(event) => patch('equipped', event.target.checked)} /><Check size={14} />Экипировано</label>
      </div> : <>
        <div className="item-eyebrow"><span>{itemTypeNames[draft.type]}</span><em className={`rarity ${draft.rarity.replace(' ', '-')}`}>{draft.rarity}</em></div>
        <h2>{draft.name}</h2><p className="item-description">{draft.description}</p>
        <div className="item-properties"><Shield size={16} /><div><small>СВОЙСТВА</small><p>{draft.properties}</p></div></div>
        <div className="item-facts"><span><b>{draft.quantity}</b><small>КОЛИЧЕСТВО</small></span><span><b>{draft.weight} фнт.</b><small>ВЕС</small></span><span><b>{draft.equipped ? 'Да' : 'Нет'}</b><small>ЭКИПИРОВАНО</small></span></div>
      </>}
      {error && <p className="item-error">{error}</p>}
      <div className="item-actions">
        {editing ? <button className="primary" onClick={() => { const saved = draft.type === 'weapon' && !draft.combat ? { ...draft, combat: defaultWeaponCombat() } : draft; setDraft(saved); onSave(saved); setEditing(false) }}><Save size={15} />Сохранить</button> : <button onClick={() => setEditing(true)}><Pencil size={15} />Редактировать</button>}
        <button onClick={createImage} disabled={generating}><Sparkles size={15} />{generating ? 'Создаём…' : draft.image ? 'Перерисовать' : 'Создать изображение'}</button>
        {!isNew && <button className="danger" onClick={() => { onRemove(draft.id); onClose() }}><Trash2 size={15} />Удалить</button>}
      </div>
    </div>
  </section></div>
}

export function InventoryView({
  player,
  party,
  busy = false,
  error,
  onEquip,
  onUse,
  onTransfer,
  onAttune,
}: {
  player: Player
  party: Player[]
  busy?: boolean
  error?: string | null
  onEquip: (itemId: string, equipped: boolean) => void
  onUse: (itemId: string, targetId?: string) => void
  onTransfer: (itemId: string, recipientId: string, quantity: number) => void
  onAttune: (itemId: string, attuned: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const recipients = party.filter((candidate) => candidate.id !== player.id)
  const [recipientId, setRecipientId] = useState(recipients[0]?.id ?? '')
  const [useTargets, setUseTargets] = useState<Record<string, string>>({})
  const useTargetOptions = [player, ...party.filter((candidate) => candidate.id !== player.id)]
  const totalWeight = useMemo(() => player.inventory.reduce((sum, item) => sum + item.weight * item.quantity, 0), [player.inventory])
  const items = player.inventory.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))

  return <section className="section-page inventory-page">
    <div className="inventory-head"><div><span>ЛИЧНЫЕ ВЕЩИ</span><h1>Инвентарь {player.character}</h1><p>Всё, что герой несёт с собой: снаряжение, находки и то, что пока не пригодилось.</p></div>
      <div className="inventory-owner"><div className="mini-owner-avatar" style={{ backgroundImage: `url(${player.portrait})`, backgroundPosition: player.portraitPosition }} /><span><small>ВЛАДЕЛЕЦ</small><b>{player.character}</b></span></div>
    </div>
    <div className="inventory-summary"><div><PackageOpen size={19} /><span><b>{player.inventory.length}</b><small>предметов</small></span></div><div><Weight size={19} /><span><b>{totalWeight.toFixed(1)} / {player.inventoryLoad?.capacity ?? player.abilities.str * 15}</b><small>фунтов</small></span></div><div><Coins size={19} /><span><b>{player.currency.gold}</b><small>золотых</small></span></div></div>
    <div className="inventory-toolbar"><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти предмет…" /></label>{recipients.length > 0 && <label className="inventory-recipient"><span>Получатель</span><select value={recipientId} disabled={busy} aria-label="Получатель передачи" onChange={(event) => setRecipientId(event.target.value)}>{recipients.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.character}</option>)}</select></label>}</div>
    {error && <p className="item-error">{error}</p>}
    {items.length ? <div className="inventory-grid">{items.map((item) => <article className="inventory-card" key={item.id}>
      <div className="inventory-art"><ItemImage item={item} />{item.equipped && <span><Check size={11} />НАДЕТО</span>}{item.quantity > 1 && <b>×{item.quantity}</b>}</div>
      <div className="inventory-card-info"><small>{itemTypeNames[item.type]}</small><strong>{item.name}</strong><p>{item.description}</p><em className={`rarity ${item.rarity.replace(' ', '-')}`}>{item.rarity}</em></div>
      {item.capabilities?.mechanics_status && item.capabilities.mechanics_status !== 'verified' && item.capabilities.limitation && <p className="item-mechanics-limitation"><b>Ограничение:</b> {item.capabilities.limitation}</p>}
      {item.capabilities?.charges && <div className="item-charge-state">Применения: <b>{item.capabilities.charges.current}/{item.capabilities.charges.max}</b></div>}
      <div className="item-actions">
        {item.capabilities?.equippable && <button disabled={busy} onClick={() => onEquip(item.id, !item.equipped)}>{item.equipped ? 'Снять' : 'Экипировать'}</button>}
        {item.capabilities?.usable && item.capabilities.use?.target === 'party' && <label className="item-use-target">
          <span>Цель</span>
          <select
            value={useTargets[item.id] ?? player.id}
            disabled={busy}
            aria-label={`Цель использования: ${item.name}`}
            onChange={(event) => setUseTargets((current) => ({ ...current, [item.id]: event.target.value }))}
          >
            {useTargetOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.character}</option>)}
          </select>
        </label>}
        {item.capabilities?.usable && <button
          disabled={busy || Boolean(item.capabilities.charges && item.capabilities.charges.current < (item.capabilities.use?.charges_per_use ?? 0))}
          onClick={() => onUse(item.id, item.capabilities?.use?.target === 'party' ? (useTargets[item.id] ?? player.id) : player.id)}
        >
          Использовать · {item.capabilities.use?.action_type === 'bonus_action' ? 'бонус' : item.capabilities.use?.action_type === 'action' ? 'действие' : 'вне боя'}
        </button>}
        {item.capabilities?.requires_attunement && <button disabled={busy} onClick={() => onAttune(item.id, item.attuned_to !== player.id)}>{item.attuned_to === player.id ? 'Разорвать настройку' : 'Настроиться'}</button>}
        {recipientId && !item.equipped && !item.attuned_to && <button disabled={busy} onClick={() => onTransfer(item.id, recipientId, 1)}>Передать 1</button>}
      </div>
    </article>)}</div> : <div className="empty-inventory"><Backpack size={31} /><h3>Ничего не найдено</h3><p>Измените запрос или получите предмет в игре.</p></div>}
  </section>
}
