import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, Backpack, Check, Coins, Download, FileJson, ImagePlus, LockKeyhole, Maximize2, PackageOpen,
  Pencil, Plus, Save, Search, Shield, Sparkles, Trash2, Upload, Weight, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { generateItemImage } from './ai-client'
import { ABILITY_SHORT_LABELS, HeroFaceInitials, hasHeroPortrait, heroFaceMode, heroFaceStyle } from './app-shared'
import { DND_CLASS_OPTIONS, classFeatureCatalogFor, playerClassKey, subclassOptionsFor } from './combat-actions'
import { fallbackCombatSpells, spellNameById, spellSelectionRules } from './combat-spells'
import { classSkillRulesFor, featureChoiceGroupsFor, normalizedSelectedFeatures } from './character-progression'
import { itemImageFor } from './item-images'
import type { FeatureChoiceGroup } from './character-progression'
import type { InventoryItem, ItemUseOptions, Player } from './types'
import { playerRoleLabel } from './player-experience'
import { CombatIcon } from './CombatIcon'
import { PhbCharacterOptions } from './PhbCharacterOptions'
import type { PhbCharacterOptionsCatalog, PhbCharacterOptionsValue } from './phb-character-types'
import { resolveCharacterCreationFeat } from '../server/character-creation-feats.mjs'

// Сокращения характеристик общие с боевой хроникой: словарь один, и лист героя
// с журналом боя не разъезжаются в подписях.
const abilityNames = ABILITY_SHORT_LABELS as Record<keyof Player['abilities'], string>
const itemTypeNames: Record<InventoryItem['type'], string> = { weapon: 'Оружие', armor: 'Доспех', consumable: 'Расходник', tool: 'Инструмент', quest: 'Задание', treasure: 'Сокровище', document: 'Документ', other: 'Прочее' }

function defaultWeaponCombat(): NonNullable<InventoryItem['combat']> {
  return { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'slashing', normalRange: 5 }
}

function modifier(score: number) {
  const value = Math.floor((score - 10) / 2)
  return value >= 0 ? `+${value}` : String(value)
}

function Field({ label, value, onChange, type = 'text', min, max, readOnly = false }: { label: string; value: string | number; onChange: (value: string) => void; type?: string; min?: number; max?: number; readOnly?: boolean }) {
  return <label className={`sheet-field${readOnly ? ' sheet-field--readonly' : ''}`}><span>{label}</span><input type={type} min={min} max={max} value={value} readOnly={readOnly} aria-readonly={readOnly} onChange={(event) => onChange(event.target.value)} /></label>
}

function TextField({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  return <label className="sheet-field textarea-field"><span>{label}</span><textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} /></label>
}

type CharacterDevelopmentStage = 'class' | 'subclass' | 'abilities' | 'choices' | 'spells'
type CharacterDevelopmentStageEntry = { id: CharacterDevelopmentStage; title: string; description: string }

function CharacterDevelopmentWizard({
  draft,
  stages,
  stage,
  onStageChange,
  stagedSetup,
  levelUpRequested,
  completed = false,
  targetLevel,
  saving,
  valid,
  notice,
  hint,
  onFinish,
  onClose,
  children,
  summary,
}: {
  draft: Player
  stages: CharacterDevelopmentStageEntry[]
  stage: CharacterDevelopmentStage
  onStageChange: (stage: CharacterDevelopmentStage) => void
  stagedSetup: boolean
  levelUpRequested: boolean
  completed?: boolean
  targetLevel: number
  saving: boolean
  valid: boolean
  notice: string
  hint: string
  onFinish: (advance: boolean) => void | Promise<unknown>
  onClose: () => void
  children: ReactNode
  summary: Array<{ label: string; value: string }>
}) {
  const currentIndex = Math.max(0, stages.findIndex((entry) => entry.id === stage))
  const last = currentIndex >= stages.length - 1
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => { mainRef.current?.scrollTo({ top: 0, behavior: 'auto' }) }, [draft.level, stage])
  const finish = (advance: boolean) => { void onFinish(advance) }
  const message = completed ? 'Все обязательные выборы сохранены. Герой готов к приключению.' : notice || (valid
    ? stagedSetup ? draft.level >= targetLevel ? `Выбор уровня ${draft.level} готов. Можно завершить подготовку.` : `Выбор уровня ${draft.level} готов. Следующий шаг — уровень ${draft.level + 1}.`
      : levelUpRequested ? 'Проверьте выборы и подтвердите повышение уровня.' : 'Изменения можно сохранить сейчас или применить при повышении уровня.'
    : hint)

  return <div className="character-creation-backdrop">
    <section className="character-creation-wizard character-development-wizard" role="dialog" aria-modal="true" aria-labelledby="character-development-title">
      <header>
        <div><Sparkles size={22} /><span><small>РАЗВИТИЕ ГЕРОЯ · УРОВЕНЬ {draft.level}</small><h2 id="character-development-title">Развитие героя</h2></span></div>
        <button type="button" onClick={onClose} aria-label="Закрыть развитие" title="Закрыть"><X size={20} /></button>
      </header>
      <nav aria-label="Шаги развития героя">
        {stages.map((entry, index) => <button
          key={entry.id}
          type="button"
          disabled={saving}
          className={entry.id === stage ? 'active' : index < currentIndex ? 'complete' : ''}
          aria-current={entry.id === stage ? 'step' : undefined}
          onClick={() => onStageChange(entry.id)}
        ><i>{index < currentIndex ? <Check size={12} /> : index + 1}</i><span><b>{entry.title}</b><small>{entry.description}</small></span></button>)}
      </nav>
      <main ref={mainRef} inert={saving} aria-busy={saving}>
        <aside className="creation-summary-rail" aria-label="Итог развития">
          <small>ИТОГ РАЗВИТИЯ</small>
          <h3>{draft.character || 'Безымянный герой'}</h3>
          <dl>{summary.map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value || '—'}</dd></div>)}</dl>
        </aside>
        {children}
      </main>
      <footer>
        <div className={notice || !valid ? 'creation-error' : ''} role={notice || !valid ? 'alert' : undefined}>{message}</div>
        {completed ? <span><button type="button" className="primary" onClick={onClose}>К приключению</button></span> : <span>
          <button type="button" disabled={saving || currentIndex === 0} onClick={() => onStageChange(stages[currentIndex - 1]?.id ?? stage)}><ArrowLeft size={15} />Назад</button>
          {last ? <>
            {!stagedSetup && !levelUpRequested && <button type="button" disabled={saving} onClick={() => finish(false)}>Сохранить выборы</button>}
            {!stagedSetup && !levelUpRequested && <button type="button" className="primary" disabled={saving} onClick={() => finish(true)}><Sparkles size={15} />Повысить уровень</button>}
            {(stagedSetup || levelUpRequested) && <button type="button" className="primary" disabled={saving} onClick={() => finish(true)}><Sparkles size={15} />{stagedSetup ? draft.level >= targetLevel ? 'Завершить подготовку' : 'Сохранить и продолжить' : 'Подтвердить повышение'}</button>}
          </> : <button type="button" className="primary" disabled={saving} onClick={() => onStageChange(stages[currentIndex + 1]?.id ?? stage)}>Дальше<ArrowRight size={15} /></button>}
        </span>}
      </footer>
    </section>
  </div>
}

export function CharacterEditor({ player, rulesetId, phbCatalog, targetLevel = player.level, initialTab = 'sheet', requestLevelUp = false, onClose, onSave, onImport, onLevelUp }: { player: Player; rulesetId?: string; phbCatalog?: PhbCharacterOptionsCatalog; targetLevel?: number; initialTab?: 'sheet' | 'story' | 'advancement'; requestLevelUp?: boolean; onClose: () => void; onSave: (patch: Partial<Player>) => void | Promise<void>; onImport: (source: string) => Promise<void>; onLevelUp: () => void | Promise<{ ok?: boolean; error?: string } | void> }) {
  const [draft, setDraft] = useState<Player>(() => structuredClone(player))
  const [tab, setTab] = useState<'sheet' | 'story' | 'advancement'>(() => player.characterSetupStage === 'leveling' ? 'advancement' : initialTab)
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const startedAsSetup = useRef(player.characterSetupStage === 'leveling')
  const [developmentStage, setDevelopmentStage] = useState<CharacterDevelopmentStage>('class')
  const [levelUpRequested, setLevelUpRequested] = useState(player.characterSetupStage === 'leveling' || requestLevelUp)
  const [developmentSearch, setDevelopmentSearch] = useState('')
  const [spellLevelFilter, setSpellLevelFilter] = useState<number | 'all'>('all')
  const avatarInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(structuredClone(player))
    if (player.characterSetupStage === 'leveling') setTab('advancement')
    if (player.characterSetupStage === 'leveling') setLevelUpRequested(true)
    setDevelopmentStage('class')
  }, [player])
  const patch = <K extends keyof Player>(key: K, value: Player[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const classKey = playerClassKey(draft)
  const classOption = DND_CLASS_OPTIONS.find((entry) => entry.key === classKey)
  const subclasses = subclassOptionsFor(draft)
  const subclassUnlocked = Boolean(classOption && draft.level >= classOption.subclassLevel)
  const spellRules = spellSelectionRules(draft)
  const spellbookMaximum = spellRules?.spellbookMinimum ?? 0
  const classSkillRules = classSkillRulesFor(draft)
  const selectedClassSkills = draft.classSkillProficiencies ?? []
  const featureChoiceGroups = featureChoiceGroupsFor(draft)
  const selectedFeatureIds = draft.selectedFeatureIds ?? []
  const developmentSpells = fallbackCombatSpells(draft)
  const knownSpellIds = draft.knownSpellIds ?? []
  const preparedSpellIds = draft.preparedSpellIds ?? []
  const availableSpellIds = new Set(developmentSpells.map((spell) => spell.id))
  const unavailableSpellIds = [...new Set([...knownSpellIds, ...preparedSpellIds])].filter((id) => !availableSpellIds.has(id))
  const knownCantrips = developmentSpells.filter((spell) => spell.level === 0 && knownSpellIds.includes(spell.id)).length
  const knownLeveled = developmentSpells.filter((spell) => spell.level > 0 && knownSpellIds.includes(spell.id)).length
  const preparedLeveled = developmentSpells.filter((spell) => spell.level > 0 && preparedSpellIds.includes(spell.id)).length
  const developmentQuery = developmentSearch.trim().toLocaleLowerCase('ru')
  const filteredClassSkills = (classSkillRules?.options ?? []).filter((skill) => !developmentQuery || `${skill.name} ${skill.ability}`.toLocaleLowerCase('ru').includes(developmentQuery))
  const filteredFeatureChoiceGroups = featureChoiceGroups.map((group) => ({
    ...group,
    options: group.options.filter((option) => !developmentQuery || `${group.name} ${option.name}`.toLocaleLowerCase('ru').includes(developmentQuery)),
  })).filter((group) => group.options.length > 0)
  const developmentFeatures = classFeatureCatalogFor(draft, true, rulesetId).filter((feature) => !developmentQuery || `${feature.name} ${feature.description} ${feature.subclass ?? ''}`.toLocaleLowerCase('ru').includes(developmentQuery))
  const filteredDevelopmentSpells = developmentSpells.filter((spell) => (spellLevelFilter === 'all' || spell.level === spellLevelFilter) && (!developmentQuery || `${spell.name} ${spell.englishName ?? ''} ${spell.description ?? ''}`.toLocaleLowerCase('ru').includes(developmentQuery)))
  const skillsValid = !Object.hasOwn(draft, 'classSkillProficiencies') || !classSkillRules || selectedClassSkills.length === classSkillRules.choiceCount
  const featureChoicesRequired = Object.hasOwn(draft, 'selectedFeatureIds') || draft.level > player.level
  const featureChoicesValid = !featureChoicesRequired || featureChoiceGroups.every((group) => group.options.filter((option) => selectedFeatureIds.includes(option.id)).length === group.choiceCount)
  const subclassValid = !subclassUnlocked || Boolean(draft.subclass)
  const abilityScoreChoiceLevels = classKey === 'fighter' ? [4, 6, 8, 12] : classKey === 'rogue' ? [4, 8, 10, 12] : [4, 8, 12]
  const stagedSetup = player.characterSetupStage === 'leveling'
  const setupTargetLevel = Math.max(draft.level, Math.min(12, Number(targetLevel) || draft.level))
  const stagedAbilityScoreLevel = abilityScoreChoiceLevels.find((level) => level <= draft.level && !draft.abilityScoreIncreases?.[String(level)] && !draft.levelFeats?.[String(level)]) ?? null
  const [abilityScoreChoice, setAbilityScoreChoice] = useState<string[]>([])
  const [improvementMode, setImprovementMode] = useState<'abilities' | 'feat'>('abilities')
  const [featChoice, setFeatChoice] = useState<PhbCharacterOptionsValue>({ schema_version: 1, classChoices: {} })
  useEffect(() => { setImprovementMode('abilities'); setFeatChoice({ schema_version: 1, classChoices: {} }) }, [stagedAbilityScoreLevel])
  const initialFeat = player.phbCreation?.feat
  const takenFeats = [...(initialFeat ? [initialFeat] : []), ...Object.values(player.levelFeats ?? {})]
  const featContext = {
    allowCappedAbilityIncrease: true,
    abilities: player.abilities,
    feats: takenFeats.map((feat) => feat.id),
    existingFeatChoices: Object.fromEntries([...new Set(takenFeats.map((feat) => feat.id))].map((id) => [id, takenFeats.filter((feat) => feat.id === id).map((feat) => feat.choices)])),
    canCastSpells: Boolean(spellRules || player.creationSpellGrants?.length),
    armor: player.creationBenefits?.armor_proficiencies ?? phbCatalog?.classes.find((entry) => entry.id === classKey)?.armor_proficiencies ?? [],
    weapons: player.creationBenefits?.weapon_proficiencies ?? [],
    skills: [...(player.classSkillProficiencies ?? []), ...(player.creationSkillProficiencies ?? [])],
    tools: player.creationBenefits?.tool_proficiencies ?? [],
    languages: player.creationBenefits?.languages ?? [],
  }
  const featResult = improvementMode === 'feat' && featChoice.feat ? resolveCharacterCreationFeat(featChoice.feat.id, featChoice.feat.choices, featContext) : null
  useEffect(() => {
    setAbilityScoreChoice(stagedAbilityScoreLevel == null ? [] : [...(draft.abilityScoreIncreases?.[String(stagedAbilityScoreLevel)] ?? [])])
  }, [draft.abilityScoreIncreases, stagedAbilityScoreLevel])
  const abilityScoreChoicesValid = stagedAbilityScoreLevel == null || (improvementMode === 'feat' ? featResult?.ok === true : [1, 2].includes(abilityScoreChoice.length))
  const abilityScoreChoiceSaved = stagedAbilityScoreLevel == null
    || JSON.stringify(player.abilityScoreIncreases?.[String(stagedAbilityScoreLevel)] ?? []) === JSON.stringify(abilityScoreChoice)
  const stagedSpellsComplete = !stagedSetup || !spellRules || (knownCantrips === spellRules.cantrips
    && (spellRules.mode !== 'known' || knownLeveled === spellRules.spellsKnown)
    && (spellRules.mode !== 'spellbook' || knownLeveled >= spellRules.spellbookMinimum)
    && preparedLeveled <= spellRules.preparedLimit)
  const developmentValid = unavailableSpellIds.length === 0 && subclassValid && skillsValid && featureChoicesValid && stagedSpellsComplete && (!spellRules || (knownCantrips <= spellRules.cantrips
    && (spellRules.mode !== 'known' || knownLeveled <= spellRules.spellsKnown)
    && (spellRules.mode !== 'spellbook' || knownLeveled <= spellbookMaximum)
    && preparedLeveled <= spellRules.preparedLimit)) && abilityScoreChoicesValid
  const developmentHint = unavailableSpellIds.length > 0
    ? `Уберите недоступные заклинания: ${unavailableSpellIds.map((id) => spellNameById(id) ?? id).join(', ')}.`
    : spellRules?.mode === 'spellbook' && knownLeveled > spellbookMaximum
      ? `В книге ${knownLeveled} заклинаний, на этом уровне разрешено ${spellbookMaximum}. Уберите лишние заклинания.`
    : !subclassValid && subclassUnlocked
    ? 'Выберите подкласс, чтобы открыть выборы этого уровня.'
    : !skillsValid ? 'Завершите выбор классовых навыков.'
      : !featureChoicesValid ? 'Завершите выбор классовых умений.'
        : !abilityScoreChoicesValid ? 'Выберите улучшение характеристик этого уровня.'
          : !stagedSpellsComplete ? 'Выберите все обязательные заговоры и заклинания этого уровня.'
            : 'Исправьте превышенные лимиты заклинаний.'
  const developmentStages = useMemo<CharacterDevelopmentStageEntry[]>(() => [
    { id: 'class', title: 'Класс', description: classOption?.label ?? 'Текущий класс' },
    ...(subclassUnlocked ? [{ id: 'subclass' as const, title: 'Подкласс', description: draft.subclass || 'Выбор подкласса' }] : []),
    ...(stagedAbilityScoreLevel != null ? [{ id: 'abilities' as const, title: 'Характеристики', description: `${stagedAbilityScoreLevel} уровень · улучшение` }] : []),
    { id: 'choices' as const, title: 'Умения', description: classSkillRules ? `Навыки ${selectedClassSkills.length}/${classSkillRules.choiceCount}` : 'Навыки и особенности' },
    ...(spellRules ? [{ id: 'spells' as const, title: 'Магия', description: 'Заклинания и подготовка' }] : []),
  ], [classOption?.label, classSkillRules, draft.subclass, selectedClassSkills.length, spellRules, stagedAbilityScoreLevel, subclassUnlocked])
  useEffect(() => {
    if (!developmentStages.some((entry) => entry.id === developmentStage)) setDevelopmentStage(developmentStages[0]?.id ?? 'class')
  }, [developmentStage, developmentStages])

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
      const maximum = spellbookMaximum
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
    const source = draft as unknown as Record<string, unknown>
    const fields = ['character', 'name', 'role', 'characterClass', 'subclass', 'species', 'background', 'alignment', 'traits', 'ideals', 'bonds', 'flaws', 'backstory', 'notes', 'level', 'experience', 'abilities', 'abilityGeneration', 'baseSpeed', 'hitPointIncreases', 'classSkillProficiencies', 'selectedFeatureIds', 'knownSpellIds', 'preparedSpellIds', 'backgroundId', 'backgroundAbilityChoice', 'backgroundChoices', 'speciesChoices', 'starterEquipmentChoices', 'phbCreation']
    const character = Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
    character.baseSpeed ??= draft.speed
    const blob = new Blob([JSON.stringify({ schema: 'skazanie.character', schema_version: 1, character }, null, 2)], { type: 'application/json' })
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(blob)
    anchor.download = `${draft.character || 'character'}-skazanie.json`
    anchor.click()
    URL.revokeObjectURL(anchor.href)
  }

  const saveCharacter = async (advance = false) => {
    if (saving) return { ok: false, error: 'Сохранение уже выполняется' }
    if (!developmentValid) {
      setTab('advancement')
      setNotice(developmentHint)
      return { ok: false, error: developmentHint }
    }
    const sanitized = {
      ...draft,
      selectedFeatureIds: normalizedSelectedFeatures(draft),
      ...(stagedAbilityScoreLevel != null ? improvementMode === 'feat' && featChoice.feat
        ? { levelFeats: { ...(draft.levelFeats ?? {}), [String(stagedAbilityScoreLevel)]: featChoice.feat } }
        : { abilityScoreIncreases: { ...(draft.abilityScoreIncreases ?? {}), [String(stagedAbilityScoreLevel)]: abilityScoreChoice } } : {}),
    }
    setSaving(true)
    setNotice('')
    try {
      await Promise.resolve(onSave(sanitized))
      const shouldAdvance = advance && (!stagedSetup || draft.level < setupTargetLevel)
      if (shouldAdvance) {
        const result = await Promise.resolve(onLevelUp())
        if (result && result.ok === false) throw new Error(result.error || 'Не удалось перейти к следующему уровню')
        if (!stagedSetup) {
          setLevelUpRequested(false)
          setDevelopmentStage('class')
        }
        return result ?? { ok: true }
      }
      if (!stagedSetup) onClose()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось сохранить выбор'
      setNotice(message)
      return { ok: false, error: message }
    } finally {
      setSaving(false)
    }
  }

  const developmentSummary = [
    ...(takenFeats.length > 0 ? [{ label: 'Черты', value: takenFeats.map((feat) => phbCatalog?.feats.find((entry) => entry.id === feat.id)?.name ?? feat.id).join(', ') }] : []),
    ...(improvementMode === 'feat' && featChoice.feat ? [{ label: 'Выбрана черта', value: phbCatalog?.feats.find((entry) => entry.id === featChoice.feat?.id)?.name ?? featChoice.feat.id }] : []),
    { label: 'Класс', value: classOption?.label ?? '' },
    { label: 'Уровень', value: stagedSetup ? `${draft.level} из ${setupTargetLevel}` : `${draft.level}` },
    { label: 'Подкласс', value: draft.subclass || (subclassUnlocked ? 'нужно выбрать' : 'ещё не открыт') },
    { label: 'Навыки', value: classSkillRules ? `${selectedClassSkills.length}/${classSkillRules.choiceCount}` : 'не требуется' },
    ...(spellRules ? [{ label: 'Магия', value: `${knownCantrips} заговоров · ${knownLeveled} заклинаний` }] : []),
  ]
  const developmentContent = <div className="development-stage-content">
    {developmentStage === 'class' && <section className="advancement-block development-stage-intro">
      <header><div><Sparkles size={17} /><span><strong>Развитие класса</strong><small>Выберите следующий обязательный шаг</small></span></div><b>{draft.level} уровень</b></header>
      <p>Класс <strong>{classOption?.label ?? 'героя'}</strong> уже выбран. Пройдите доступные этапы слева, затем сохраните выборы или подтвердите повышение уровня.</p>
      {classOption && <p>Новые особенности класса открываются автоматически по правилам. Подкласс и выборы появятся на требуемом уровне.</p>}
    </section>}
    {developmentStage === 'subclass' && <section className="advancement-block development-stage-panel">
      <header><div><Sparkles size={17} /><span><strong>Подкласс</strong><small>Обязательный выбор при открытии</small></span></div><b className={!subclassValid ? 'invalid' : ''}>{draft.subclass ? 'готово' : 'нужно выбрать'}</b></header>
      <label className="sheet-field staged-subclass-choice"><span>Подкласс · с {classOption?.subclassLevel ?? 1} уровня</span><select value={draft.subclass ?? ''} onChange={(event) => {
        const nextSubclass = event.target.value || undefined
        setDraft((current) => {
          const next = { ...current, subclass: nextSubclass }
          return { ...next, selectedFeatureIds: normalizedSelectedFeatures(next) }
        })
      }}><option value="">Выберите подкласс</option>{subclasses.map((entry) => <option key={entry.id} value={entry.name}>{entry.name}</option>)}</select></label>
      <p>Выбор сохраняется в листе героя и используется сервером при проверке доступных особенностей.</p>
    </section>}
    {developmentStage === 'abilities' && <section className="advancement-block ability-score-development">
      <header><div><Sparkles size={17} /><span><strong>Развитие · {stagedAbilityScoreLevel} уровень</strong><small>Улучшение характеристик{rulesetId === 'dnd_5e_2014' ? ' или черта PHB 2014' : ''}</small></span></div><b className={!abilityScoreChoicesValid ? 'invalid' : ''}>{improvementMode === 'feat' ? featResult?.ok ? 'готово' : 'выберите черту' : `${abilityScoreChoice.length}/2`}</b></header>
      {rulesetId === 'dnd_5e_2014' && phbCatalog && <div className="development-improvement-mode" role="group" aria-label="Способ улучшения героя"><button type="button" aria-pressed={improvementMode === 'abilities'} onClick={() => setImprovementMode('abilities')}>Повысить характеристики</button><button type="button" aria-pressed={improvementMode === 'feat'} onClick={() => setImprovementMode('feat')}>Выбрать черту</button></div>}
      {improvementMode === 'feat' && phbCatalog ? <div className="development-feat-choice"><PhbCharacterOptions catalog={phbCatalog} classId={classKey ?? ''} subclass={draft.subclass} abilities={player.abilities} knownSkillIds={featContext.skills} knownToolIds={Array.isArray(featContext.tools) ? featContext.tools as string[] : []} variantHuman={false} featOnly featContext={featContext} value={featChoice} onChange={setFeatChoice} />{featChoice.feat && !featResult?.ok && <p role="status">{featResult?.reason}</p>}</div> : <div className="ability-score-choice-grid">
        <label><span>Первая прибавка</span><select value={abilityScoreChoice[0] ?? ''} onChange={(event) => setAbilityScoreChoice((current) => [event.target.value, current[1]].filter(Boolean))}><option value="">Выберите характеристику</option>{Object.keys(abilityNames).map((ability) => <option key={ability} value={ability}>{abilityNames[ability as keyof Player['abilities']]}</option>)}</select></label>
        <label><span>Вторая прибавка <small>(пусто = +2 к первой)</small></span><select value={abilityScoreChoice[1] ?? ''} onChange={(event) => setAbilityScoreChoice((current) => event.target.value ? [current[0] ?? '', event.target.value].filter(Boolean) : [current[0]].filter(Boolean))}><option value="">Не выбирать</option>{Object.keys(abilityNames).map((ability) => <option key={ability} value={ability}>{abilityNames[ability as keyof Player['abilities']]}</option>)}</select></label>
      </div>}
    </section>}
    {developmentStage === 'choices' && <>
      <label className="advancement-search"><Search size={16} /><input value={developmentSearch} onChange={(event) => setDevelopmentSearch(event.target.value)} placeholder="Поиск навыка, умения или заклинания…" /></label>
      <section className="advancement-block skill-development">
        <header><div><Check size={17} /><span><strong>Владение навыками</strong><small>Классовый выбор</small></span></div>{classSkillRules && <b className={selectedClassSkills.length !== classSkillRules.choiceCount ? 'invalid' : ''}>{selectedClassSkills.length}/{classSkillRules.choiceCount}</b>}</header>
        {classSkillRules ? <div className="class-skill-list">{filteredClassSkills.map((skill) => {
          const selected = selectedClassSkills.includes(skill.id)
          return <button key={skill.id} className={selected ? 'selected' : ''} onClick={() => toggleClassSkill(skill.id)}><i>{selected ? <Check size={14} /> : <Plus size={14} />}</i><span><strong>{skill.name}</strong><small>{skill.ability.toUpperCase()}</small></span></button>
        })}</div> : <p className="advancement-empty">Для этого класса нет отдельного выбора навыков.</p>}
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
    </>}
    {developmentStage === 'spells' && <section className="advancement-block spell-development">
      <header><div><Sparkles size={17} /><span><strong>Заклинания</strong><small>{spellRules ? spellRules.mode === 'known' ? 'Известные заклинания' : spellRules.mode === 'spellbook' ? 'Книга и подготовка' : 'Подготовка после отдыха' : 'Этот класс не использует заклинания'}</small></span></div>{spellRules && <b>до {spellRules.maximumSpellLevel} круга</b>}</header>
      {unavailableSpellIds.length > 0 && <div className="development-unavailable-spells" role="alert"><p>Эти заклинания недоступны для текущего класса, уровня или набора правил. Уберите их из выбора, чтобы продолжить.</p>{unavailableSpellIds.map((id) => <button key={id} type="button" onClick={() => {
        setDraft((current) => ({ ...current, knownSpellIds: (current.knownSpellIds ?? []).filter((spellId) => spellId !== id), preparedSpellIds: (current.preparedSpellIds ?? []).filter((spellId) => spellId !== id) }))
        setNotice('')
      }}><X size={14} />Убрать «{spellNameById(id) ?? id}»</button>)}</div>}
      {spellRules ? <>
        <label className="advancement-search"><Search size={16} /><input type="search" aria-label="Поиск заклинаний" value={developmentSearch} onChange={(event) => setDevelopmentSearch(event.target.value)} placeholder="Название или описание заклинания…" /></label>
        <div className="spell-choice-counters">
          {spellRules.cantrips > 0 && <span className={knownCantrips > spellRules.cantrips ? 'invalid' : ''}>Заговоры <b>{knownCantrips}/{spellRules.cantrips}</b></span>}
          {spellRules.mode === 'known' && <span className={knownLeveled > spellRules.spellsKnown ? 'invalid' : ''}>Известно <b>{knownLeveled}/{spellRules.spellsKnown}</b></span>}
          {spellRules.mode === 'spellbook' && <span className={knownLeveled > spellbookMaximum ? 'invalid' : ''}>В книге <b>{knownLeveled}/{spellbookMaximum}</b></span>}
          {(spellRules.mode === 'prepared' || spellRules.mode === 'spellbook') && <span className={preparedLeveled > spellRules.preparedLimit ? 'invalid' : ''}>Подготовлено <b>{preparedLeveled}/{spellRules.preparedLimit}</b></span>}
        </div>
        <nav className="advancement-level-filter"><button className={spellLevelFilter === 'all' ? 'active' : ''} onClick={() => setSpellLevelFilter('all')}>Все</button>{[...new Set(developmentSpells.map((spell) => spell.level))].sort((a, b) => a - b).map((level) => <button key={level} className={spellLevelFilter === level ? 'active' : ''} onClick={() => setSpellLevelFilter(level)}>{level === 0 ? 'Заговоры' : level}</button>)}</nav>
        {filteredDevelopmentSpells.length === 0 && <p className="advancement-empty" role="status">Заклинания не найдены. Измените запрос или выбранный круг.</p>}
        <div className="development-spell-list">{filteredDevelopmentSpells.map((spell) => {
          const known = knownSpellIds.includes(spell.id)
          const prepared = preparedSpellIds.includes(spell.id)
          return <article key={spell.id} className={known || prepared ? 'selected' : ''}><CombatIcon id={spell.id} kind="spell" hint={spell.name} size={48} /><span><strong>{spell.name}</strong><small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spell.castingTime || '1 действие'} · {spell.rangeText || `${spell.range} фт.`}</small><p>{spell.description}</p></span><div>
            {spell.level === 0 || spellRules.mode === 'known' ? <button className={known ? 'active' : ''} onClick={() => toggleDevelopmentSpell(spell.id)}>{known ? <Check size={13} /> : <Plus size={13} />}{spell.level === 0 ? 'Изучен' : 'Выбрать'}</button> : spellRules.mode === 'spellbook' ? <><button className={known ? 'active' : ''} onClick={() => toggleDevelopmentSpell(spell.id)}>{known ? <Check size={13} /> : <Plus size={13} />}Книга</button><button className={prepared ? 'active' : ''} disabled={!known} onClick={() => toggleDevelopmentSpell(spell.id, true)}>{prepared ? <Check size={13} /> : <Plus size={13} />}Подготовить</button></> : <button className={prepared ? 'active' : ''} onClick={() => toggleDevelopmentSpell(spell.id, true)}>{prepared ? <Check size={13} /> : <Plus size={13} />}Подготовить</button>}
          </div></article>
        })}</div>
      </> : <p className="advancement-empty">Заклинания появятся здесь автоматически, если выбран класс-заклинатель.</p>}
    </section>}
  </div>

  if (startedAsSetup.current && !player.characterSetupRequired && player.level >= targetLevel) return <CharacterDevelopmentWizard
    draft={draft}
    stages={developmentStages}
    stage={developmentStage}
    onStageChange={setDevelopmentStage}
    stagedSetup={false}
    levelUpRequested={false}
    completed
    targetLevel={setupTargetLevel}
    saving={false}
    valid
    notice=""
    hint=""
    onFinish={onClose}
    onClose={onClose}
    summary={developmentSummary}
  >
    <section className="advancement-block development-stage-intro character-development-complete">
      <header><div><Sparkles size={20} /><span><strong>Герой готов к приключению</strong><small>{playerRoleLabel(player)}</small></span></div><b>{player.level} уровень</b></header>
      <p>Все обязательные выборы сохранены. Здоровье: {player.hp} из {player.maxHp}. Можно присоединяться к отряду.</p>
    </section>
  </CharacterDevelopmentWizard>

  if (tab === 'advancement') return <CharacterDevelopmentWizard
    draft={draft}
    stages={developmentStages}
    stage={developmentStage}
    onStageChange={setDevelopmentStage}
    stagedSetup={stagedSetup}
    levelUpRequested={levelUpRequested}
    targetLevel={setupTargetLevel}
    saving={saving}
    valid={developmentValid}
    notice={notice}
    hint={developmentHint}
    onFinish={saveCharacter}
    onClose={onClose}
    summary={developmentSummary}
  >{developmentContent}</CharacterDevelopmentWizard>

  return (
    <div className="sheet-overlay" onMouseDown={onClose}>
      <section className="character-editor" role="dialog" aria-modal="true" aria-label={`Лист персонажа: ${draft.character}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="editor-head">
          <div className="editor-avatar" data-face={heroFaceMode(draft)} style={heroFaceStyle(draft)}>
            {!hasHeroPortrait(draft) && <HeroFaceInitials hero={draft} />}
            <button onClick={() => avatarInput.current?.click()}><ImagePlus size={17} />Сменить фото</button>
            <input ref={avatarInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => uploadAvatar(event.target.files?.[0])} />
          </div>
          <div><span>ЛИСТ ПЕРСОНАЖА</span><h2>{draft.character}</h2><p>{playerRoleLabel(draft)}</p></div>
          <div className="editor-actions">
            <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => importSheet(event.target.files?.[0])} />
            <button onClick={() => importInput.current?.click()} disabled={saving}><Upload size={15} />Импорт Skazanie JSON</button>
            <button onClick={exportSheet}><Download size={15} />Экспорт</button>
            <button className="close-editor" onClick={onClose} disabled={saving} aria-label="Закрыть лист персонажа"><X size={20} /></button>
          </div>
        </header>
        <nav className="editor-tabs"><button disabled={saving} className={tab === 'sheet' ? 'active' : ''} onClick={() => setTab('sheet')}>Основной лист</button><button disabled={saving} className={tab === 'story' ? 'active' : ''} onClick={() => setTab('story')}>История и особенности</button><button disabled={saving} className={String(tab) === 'advancement' ? 'active' : ''} onClick={() => setTab('advancement')}><Sparkles size={14} />Развитие</button>{!stagedSetup && <button onClick={() => { setLevelUpRequested(true); setDevelopmentStage('class'); setTab('advancement') }} disabled={saving || !developmentValid || !abilityScoreChoiceSaved}><Sparkles size={14} />Повысить уровень</button>}<span><Backpack size={14} />{draft.inventory.length} предметов</span></nav>
        <div className="editor-content">
          {tab === 'sheet' ? <>
            <div className="sheet-section identity-grid">
              <Field label="Имя персонажа" value={draft.character} onChange={(value) => patch('character', value)} />
              <Field label="Имя игрока" value={draft.name} onChange={(value) => patch('name', value)} />
              <label className="sheet-field sheet-field--readonly"><span>Класс</span><select value={classKey ?? ''} disabled onChange={(event) => {
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
              <p className="sheet-section-note">Боевые параметры рассчитаны правилами игры.</p>
              <Field label="Уровень" type="number" min={1} max={12} value={draft.level} readOnly onChange={(value) => {
                const level = Math.max(1, Math.min(12, Number(value) || 1))
                setDraft((current) => ({ ...current, level, role: classOption ? `${classOption.label} · ур. ${level}` : current.role }))
              }} />
              <Field label="Опыт" type="number" min={0} value={draft.experience} readOnly onChange={(value) => patch('experience', Number(value))} />
              <Field label="Текущие хиты" type="number" min={0} value={draft.hp} readOnly onChange={(value) => patch('hp', Number(value))} />
              <Field label="Максимум хитов" type="number" min={1} value={draft.maxHp} readOnly onChange={(value) => patch('maxHp', Number(value))} />
              <Field label="Класс доспеха" type="number" min={0} value={draft.armor} readOnly onChange={(value) => patch('armor', Number(value))} />
              <Field label="Скорость" type="number" min={0} value={draft.speed} readOnly onChange={(value) => patch('speed', Number(value))} />
              <Field label="Бонус мастерства" type="number" min={0} value={draft.proficiency} readOnly onChange={(value) => patch('proficiency', Number(value))} />
            </div>
            <div className="currency-editor"><span><Coins size={16} />Монеты</span>{(['copper', 'silver', 'gold', 'platinum'] as const).map((key) => <Field key={key} label={{ copper: 'Медь', silver: 'Серебро', gold: 'Золото', platinum: 'Платина' }[key]} type="number" min={0} value={draft.currency[key]} readOnly onChange={(value) => patch('currency', { ...draft.currency, [key]: Number(value) })} />)}</div>
          </> : tab === 'story' ? <div className="story-editor-grid">
            {player.creationBenefits && <section className="advancement-block">
              <h3>Создание по PHB 2014</h3>
              <p>Инструменты: {Array.isArray(player.creationBenefits.tool_proficiency_labels) ? player.creationBenefits.tool_proficiency_labels.join(', ') || 'нет' : 'нет'}</p>
              <p>Языки: {Array.isArray(player.creationBenefits.language_labels) ? player.creationBenefits.language_labels.join(', ') : ''}</p>
              {Array.isArray(player.creationBenefits.owned_assets) && player.creationBenefits.owned_assets.length > 0 && <p>Имущество вне рюкзака: {player.creationBenefits.owned_assets.map((asset) => String((asset as { name: string }).name)).join(', ')}.</p>}
              {Array.isArray(player.creationBenefits.domain_spell_names) && player.creationBenefits.domain_spell_names.length > 0 && <p>Всегда подготовленные заклинания домена: {player.creationBenefits.domain_spell_names.join(', ')}</p>}
              {player.creationBenefits.feat != null && <p>Черта: {String((player.creationBenefits.feat as { name?: string }).name ?? '')}. Игровые эффекты черт поддержаны частично.</p>}
              {((player.creationBenefits.class as { features?: Array<{ id: string; name: string; summary: string }> })?.features ?? []).map((feature) => <p key={feature.id}><strong>{feature.name}.</strong> {feature.summary}</p>)}
            </section>}
            <TextField label="Предыстория" value={draft.backstory} onChange={(value) => patch('backstory', value)} rows={7} />
            <TextField label="Черты характера" value={draft.traits} onChange={(value) => patch('traits', value)} />
            <TextField label="Идеалы" value={draft.ideals} onChange={(value) => patch('ideals', value)} />
            <TextField label="Привязанности" value={draft.bonds} onChange={(value) => patch('bonds', value)} />
            <TextField label="Слабости" value={draft.flaws} onChange={(value) => patch('flaws', value)} />
            <TextField label="Умения и особенности" value={draft.features} onChange={(value) => patch('features', value)} rows={6} />
            <TextField label="Заметки" value={draft.notes} onChange={(value) => patch('notes', value)} rows={5} />
          </div> : developmentContent}
        </div>
        <footer className="editor-footer"><p>{notice || (developmentValid ? stagedSetup ? `Уровень ${draft.level} из ${setupTargetLevel}: выбор готов.` : 'Изменения сохраняются в общей сессии и сразу видны отряду.' : developmentHint)}</p><button onClick={() => { void saveCharacter() }} disabled={saving}><Save size={16} />{saving ? 'Сохраняем…' : stagedSetup ? (draft.level >= setupTargetLevel ? 'Завершить подготовку' : `Сохранить выбор и перейти к уровню ${draft.level + 1}`) : 'Сохранить персонажа'}</button></footer>
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
  enemyTargets = [],
  combatActive = false,
  combatItemTurnAvailable = false,
  combatBonusActionAvailable = true,
  busy = false,
  error,
  onEquip,
  onUse,
  onTransfer,
  onAttune,
  onActivate,
  onCreateHero,
}: {
  player: Player
  party: Player[]
  enemyTargets?: Array<{ id: string; label: string }>
  combatActive?: boolean
  combatItemTurnAvailable?: boolean
  combatBonusActionAvailable?: boolean
  busy?: boolean
  error?: string | null
  onEquip: (itemId: string, equipped: boolean) => void
  onUse: (itemId: string, options?: ItemUseOptions) => void
  onTransfer: (itemId: string, recipientId: string, quantity: number) => void
  onAttune: (itemId: string, attuned: boolean) => void
  onActivate: (itemId: string, activated: boolean) => void
  onCreateHero?: () => void
}) {
  const [query, setQuery] = useState('')
  const recipients = party.filter((candidate) => candidate.id !== player.id)
  const [recipientId, setRecipientId] = useState(recipients[0]?.id ?? '')
  const [useTargets, setUseTargets] = useState<Record<string, string>>({})
  const [chargeSpends, setChargeSpends] = useState<Record<string, number>>({})
  const [useModes, setUseModes] = useState<Record<string, 'target' | 'spill'>>({})
  const [pointTargets, setPointTargets] = useState<Record<string, { x: number; y: number }>>({})
  const [weaponTargets, setWeaponTargets] = useState<Record<string, string>>({})
  const useTargetOptions = [player, ...party.filter((candidate) => candidate.id !== player.id)]
  const usableWeapons = player.inventory.filter((item) => item.type === 'weapon' && item.quantity > 0)
  const totalWeight = useMemo(() => player.inventory.reduce((sum, item) => sum + item.weight * item.quantity, 0), [player.inventory])
  const items = player.inventory.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
  const setupRequired = player.characterSetupRequired === true
  const emptyInventoryMessage = setupRequired
    ? { title: 'Герой ещё не создан', text: 'Сначала завершите создание героя — после этого здесь появятся его вещи.', action: 'Создать героя' }
    : query.trim()
      ? { title: 'Ничего не найдено', text: 'Попробуйте изменить запрос или очистить поиск.', action: null }
      : { title: 'Сумка пуста', text: 'Предметы появятся здесь, когда герой найдёт или получит их в приключении.', action: null }
  const enemyTargetFor = (itemId: string) => {
    const selected = useTargets[itemId]
    return enemyTargets.some((candidate) => candidate.id === selected) ? selected : enemyTargets[0]?.id
  }
  const chargesToSpendFor = (item: InventoryItem) => {
    const use = item.capabilities?.use
    const minimum = use?.min_charges_to_spend
    const maximum = use?.max_charges_to_spend
    if (minimum == null || maximum == null) return undefined
    const availableMaximum = Math.min(maximum, item.capabilities?.charges?.current ?? 0)
    if (availableMaximum < minimum) return minimum
    const preferred = chargeSpends[item.id] ?? use?.default_charges_to_spend ?? minimum
    return Math.max(minimum, Math.min(availableMaximum, preferred))
  }
  const useModeFor = (item: InventoryItem) => useModes[item.id] ?? 'target'
  const pointTargetFor = (item: InventoryItem) => pointTargets[item.id] ?? { x: player.x, y: player.y }
  const weaponTargetFor = (item: InventoryItem) => {
    const selected = weaponTargets[item.id]
    return usableWeapons.some((weapon) => weapon.id === selected)
      ? selected
      : usableWeapons.find((weapon) => weapon.equipped)?.id ?? usableWeapons[0]?.id
  }
  const useOptionsFor = (item: InventoryItem): ItemUseOptions => {
    const use = item.capabilities?.use
    const mode = useModeFor(item)
    const targetsCreature = ['enemy', 'creature'].includes(use?.target ?? '')
    const usesPoint = use?.point_target === true && (use.kind === 'spill_zone' || mode === 'spill')
    return {
      targetId: targetsCreature && !usesPoint
        ? enemyTargetFor(item.id)
        : use?.target === 'party'
          ? (useTargets[item.id] ?? player.id)
          : player.id,
      chargesToSpend: chargesToSpendFor(item),
      ...(usesPoint ? { to: pointTargetFor(item) } : {}),
      ...(mode === 'spill' ? { useMode: 'spill' } : {}),
      ...(use?.requires_weapon ? { weaponId: weaponTargetFor(item) } : {}),
    }
  }
  const useDisabledReasonFor = (item: InventoryItem) => {
    const use = item.capabilities?.use
    if (!use) return ''
    if (use.combat_only && !combatActive) return 'Использовать можно только в бою.'
    if (use.combat_only && !combatItemTurnAvailable) return 'Использовать можно только в свой ход.'
    if (use.requires_equipped && !item.equipped) return 'Сначала экипируйте предмет.'
    if (['enemy', 'creature'].includes(use.target ?? '') && useModeFor(item) !== 'spill' && enemyTargets.length === 0) return 'Подходящей цели рядом нет.'
    if (use.requires_weapon && !weaponTargetFor(item)) return 'Выберите оружие для этого действия.'
    if (item.capabilities?.charges && item.capabilities.charges.current < (chargesToSpendFor(item) ?? use.charges_per_use ?? 0)) return 'Недостаточно зарядов.'
    return ''
  }

  return <section className="section-page inventory-page">
    <div className="inventory-head"><div><span>Инвентарь</span><h1>{player.character}</h1><p>Снаряжение и находки героя.</p></div>
      <div className="inventory-owner"><div className="mini-owner-avatar" data-face={heroFaceMode(player)} style={heroFaceStyle(player)}>{!hasHeroPortrait(player) && <HeroFaceInitials hero={player} />}</div><span><small>Герой</small><b>{player.character}</b></span></div>
    </div>
    <div className="inventory-summary"><div><PackageOpen size={19} /><span><b>{player.inventory.length}</b><small>предметов</small></span></div><div><Weight size={19} /><span><b>{totalWeight.toFixed(1)} / {player.inventoryLoad?.capacity ?? player.abilities.str * 15}</b><small>фунтов</small></span></div><div><Coins size={19} /><span><b>{player.currency.gold}</b><small>золотых</small></span></div></div>
    <div className="inventory-toolbar"><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти предмет…" /></label>{recipients.length > 0 && <label className="inventory-recipient"><span>Получатель</span><select value={recipientId} disabled={busy} aria-label="Получатель передачи" onChange={(event) => setRecipientId(event.target.value)}>{recipients.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.character}</option>)}</select></label>}</div>
    {error && <p className="item-error">{error}</p>}
    {items.length ? <div className="inventory-grid">{items.map((item) => <article className="inventory-card" key={item.id}>
      <div className="inventory-art"><ItemImage item={item} />{item.equipped && <span><Check size={11} />НАДЕТО</span>}{item.quantity > 1 && <b>×{item.quantity}</b>}{item.origin === 'stolen' && <i className="item-stolen-mark" title="Краденое. Это видите только вы и ведущий: за столом о находке никто не знает, пока вы не скажете сами.">КРАДЕНОЕ</i>}</div>
      <div className="inventory-card-info"><small>{itemTypeNames[item.type]}</small><strong>{item.name}</strong><p>{item.description}</p><em className={`rarity ${item.rarity.replace(' ', '-')}`}>{item.rarity}</em></div>
      {item.capabilities?.mechanics_status && item.capabilities.mechanics_status !== 'verified' && item.capabilities.limitation && <details className="item-mechanics-limitation">
        <summary><strong>{item.capabilities.mechanics_status === 'ruling-only' ? 'Требует решения ведущего' : 'Частично поддерживается'}</strong><span>Подробнее</span></summary>
        <p>{item.capabilities.limitation}</p>
      </details>}
      {item.capabilities?.charges && <div className="item-charge-state">Применения: <b>{item.capabilities.charges.current}/{item.capabilities.charges.max}</b></div>}
      <div className="item-actions">
        {item.capabilities?.equippable && <button disabled={busy} onClick={() => onEquip(item.id, !item.equipped)}>{item.equipped ? 'Снять' : 'Экипировать'}</button>}
        {item.capabilities?.usable && item.capabilities.use?.use_modes && <label className="item-use-target">
          <span>Режим</span>
          <select
            value={useModeFor(item)}
            disabled={busy}
            aria-label={`Режим использования: ${item.name}`}
            onChange={(event) => setUseModes((current) => ({ ...current, [item.id]: event.target.value as 'target' | 'spill' }))}
          >
            <option value="target">Бросить в цель</option>
            <option value="spill">Разлить на клетку</option>
          </select>
        </label>}
        {item.capabilities?.usable && ['party', 'enemy', 'creature'].includes(item.capabilities.use?.target ?? '')
          && !(item.capabilities.use?.point_target && useModeFor(item) === 'spill') && <label className="item-use-target">
          <span>Цель</span>
          <select
            value={['enemy', 'creature'].includes(item.capabilities.use?.target ?? '') ? enemyTargetFor(item.id) ?? '' : useTargets[item.id] ?? player.id}
            disabled={busy}
            aria-label={`Цель использования: ${item.name}`}
            onChange={(event) => setUseTargets((current) => ({ ...current, [item.id]: event.target.value }))}
          >
            {(['enemy', 'creature'].includes(item.capabilities.use?.target ?? '')
              ? enemyTargets
              : useTargetOptions.map((candidate) => ({ id: candidate.id, label: candidate.character })))
              .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>
        </label>}
        {item.capabilities?.usable && item.capabilities.use?.point_target
          && (item.capabilities.use.kind === 'spill_zone' || useModeFor(item) === 'spill') && <fieldset className="item-point-target">
          <legend>Клетка</legend>
          <label><span>X</span><input type="number" value={pointTargetFor(item).x} disabled={busy} aria-label={`Координата X: ${item.name}`} onChange={(event) => setPointTargets((current) => ({ ...current, [item.id]: { ...pointTargetFor(item), x: Number(event.target.value) } }))} /></label>
          <label><span>Y</span><input type="number" value={pointTargetFor(item).y} disabled={busy} aria-label={`Координата Y: ${item.name}`} onChange={(event) => setPointTargets((current) => ({ ...current, [item.id]: { ...pointTargetFor(item), y: Number(event.target.value) } }))} /></label>
        </fieldset>}
        {item.capabilities?.usable && item.capabilities.use?.requires_weapon && <label className="item-use-target">
          <span>Оружие</span>
          <select value={weaponTargetFor(item) ?? ''} disabled={busy || usableWeapons.length === 0} aria-label={`Оружие для покрытия: ${item.name}`} onChange={(event) => setWeaponTargets((current) => ({ ...current, [item.id]: event.target.value }))}>
            {usableWeapons.map((weapon) => <option key={weapon.id} value={weapon.id}>{weapon.name}{weapon.equipped ? ' · в руках' : ''}</option>)}
          </select>
        </label>}
        {item.capabilities?.usable && item.capabilities.use?.min_charges_to_spend != null && item.capabilities.use.max_charges_to_spend != null && <label className="item-charge-spend">
          <span>Заряды</span>
          <select
            value={chargesToSpendFor(item)}
            disabled={busy}
            aria-label={`Заряды для использования: ${item.name}`}
            onChange={(event) => setChargeSpends((current) => ({ ...current, [item.id]: Number(event.target.value) }))}
          >
            {Array.from(
              { length: Math.max(0, Math.min(item.capabilities.use.max_charges_to_spend, item.capabilities.charges?.current ?? 0) - item.capabilities.use.min_charges_to_spend + 1) },
              (_, index) => item.capabilities!.use!.min_charges_to_spend! + index,
            ).map((charges) => <option key={charges} value={charges}>{charges}</option>)}
          </select>
        </label>}
        {item.capabilities?.usable && <button
          disabled={busy
            || Boolean(item.capabilities.use?.combat_only && (!combatActive || !combatItemTurnAvailable))
            || Boolean(item.capabilities.use?.requires_equipped && !item.equipped)
            || Boolean(['enemy', 'creature'].includes(item.capabilities.use?.target ?? '') && useModeFor(item) !== 'spill' && enemyTargets.length === 0)
            || Boolean(item.capabilities.use?.requires_weapon && !weaponTargetFor(item))
            || Boolean(item.capabilities.charges && item.capabilities.charges.current < (
              chargesToSpendFor(item) ?? item.capabilities.use?.charges_per_use ?? 0
            ))}
          title={useDisabledReasonFor(item) || undefined}
          onClick={() => onUse(item.id, useOptionsFor(item))}
        >
          Использовать · {item.capabilities.use?.action_type === 'bonus_action' ? 'бонус' : item.capabilities.use?.action_type === 'action' ? 'действие' : 'вне боя'}
        </button>}
        {item.capabilities?.usable && useDisabledReasonFor(item) && <small className="item-use-hint">{useDisabledReasonFor(item)}</small>}
        {item.capabilities?.activatable && <button
          disabled={busy
            || Boolean(item.capabilities.activation?.requires_equipped && !item.equipped)
            || Boolean(item.capabilities.activation?.requires_attunement && item.attuned_to !== player.id)
            || Boolean(combatActive && (!combatItemTurnAvailable || !combatBonusActionAvailable))}
          title={item.capabilities.activation?.requires_equipped && !item.equipped
            ? 'Сначала экипируйте предмет.'
            : item.capabilities.activation?.requires_attunement && item.attuned_to !== player.id
              ? 'Сначала настройтесь на предмет.'
              : combatActive && !combatItemTurnAvailable
                ? 'Активировать предмет можно только в свой ход.'
                : combatActive && !combatBonusActionAvailable
                  ? 'Бонусное действие уже потрачено.'
                  : undefined}
          onClick={() => onActivate(item.id, !(item.capabilities?.activated ?? item.activated === true))}
        >
          {(item.capabilities.activated ?? item.activated === true) ? 'Погасить' : 'Зажечь'}{combatActive ? ' · бонус' : ''}
        </button>}
        {item.capabilities?.requires_attunement && <button disabled={busy} onClick={() => onAttune(item.id, item.attuned_to !== player.id)}>{item.attuned_to === player.id ? 'Разорвать настройку' : 'Настроиться'}</button>}
        {recipientId && !item.equipped && !item.attuned_to && <button disabled={busy} onClick={() => onTransfer(item.id, recipientId, 1)}>Передать 1</button>}
      </div>
    </article>)}</div> : <div className={`empty-inventory${setupRequired ? ' empty-inventory--setup' : ''}`}><Backpack size={31} /><h3>{emptyInventoryMessage.title}</h3><p>{emptyInventoryMessage.text}</p>{emptyInventoryMessage.action && onCreateHero && <button type="button" onClick={onCreateHero}><Sparkles size={15} />{emptyInventoryMessage.action}</button>}</div>}
  </section>
}
