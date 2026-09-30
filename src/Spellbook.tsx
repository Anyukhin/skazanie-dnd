import { useEffect, useMemo, useRef, useState } from 'react'
import { SpellDetail, spellLevelLabel, type SpellbookSpell } from './SpellDetail'
import { CombatIcon } from './CombatIcon'
import './spellbook.css'
import spellDescriptionCatalog from '../data/spell-descriptions-ru.json'
import { readableSpellText } from './spell-explanations'

type ReaderDescriptionCatalog = { details?: Record<string, string> }
const readerDetails = (spellDescriptionCatalog as unknown as ReaderDescriptionCatalog).details ?? {}

export type SpellbookProps = {
  spells: readonly SpellbookSpell[]
  catalogSpells?: readonly SpellbookSpell[]
  activeName?: string
  open?: boolean
  initialSpellId?: string | null
  pinnedSpellIds?: readonly string[]
  onClose?: () => void
  onSelect?: (spell: SpellbookSpell) => void
  onPin?: (spellId: string) => void
  isPinDisabled?: (spell: SpellbookSpell) => boolean
  isSelectionDisabled?: (spell: SpellbookSpell) => boolean
  blockedReasonFor?: (spell: SpellbookSpell) => string | null | undefined
}

const normalized = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase('ru')
const cleanReason = (value: unknown) => String(value ?? '').trim().replace(/[.!?]+$/u, '')

export function Spellbook({ spells, catalogSpells = spells, activeName = 'Герой', open = true, initialSpellId, pinnedSpellIds = [], onClose, onSelect, onPin, isPinDisabled, isSelectionDisabled, blockedReasonFor }: SpellbookProps) {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<number | 'all'>('all')
  const [scope, setScope] = useState<'hero' | 'catalog'>('hero')
  const [selectedId, setSelectedId] = useState<string | null>(initialSpellId ?? spells[0]?.id ?? null)
  const detailPanelRef = useRef<HTMLDivElement>(null)
  const pinned = useMemo(() => new Set(pinnedSpellIds), [pinnedSpellIds])
  const visibleSpells = scope === 'catalog' ? catalogSpells : spells
  const levels = useMemo(() => [...new Set(visibleSpells.map((spell) => spell.level).filter((entry) => Number.isFinite(entry)))].sort((a, b) => a - b), [visibleSpells])
  const filtered = useMemo(() => {
    const needle = normalized(query)
    return visibleSpells.filter((spell) => {
      if (level !== 'all' && spell.level !== level) return false
      if (!needle) return true
      return normalized(`${spell.name} ${spell.englishName ?? ''} ${spell.school ?? ''} ${spell.description ?? ''} ${readerDetails[spell.id] ?? ''}`).includes(needle)
    })
  }, [level, query, visibleSpells])
  const selected = filtered.find((spell) => spell.id === selectedId) ?? filtered[0] ?? null
  const selectedVisibleId = selected?.id ?? null
  const switchScope = (next: 'hero' | 'catalog') => { setScope(next); setLevel('all') }

  useEffect(() => {
    if (selectedVisibleId !== selectedId) setSelectedId(selectedVisibleId)
  }, [selectedVisibleId, selectedId])
  useEffect(() => { detailPanelRef.current?.scrollTo({ top: 0 }) }, [selectedVisibleId])

  if (!open) return null
  return <section className="spellbook-catalog" role="dialog" aria-modal="true" aria-label={`Книга заклинаний: ${activeName}`} onPointerDown={(event) => event.stopPropagation()}>
    <header className="spellbook-catalog-header">
      <div><h1>Книга заклинаний</h1><p>{scope === 'hero' ? `${activeName} · ${spells.length} в списке` : `Весь каталог · ${catalogSpells.length} карточек`}</p></div>
      {onClose && <button type="button" onClick={onClose} aria-label="Закрыть книгу заклинаний">Закрыть</button>}
    </header>
    <div className="spellbook-catalog-tools">
      <label><span>Поиск</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название, школа или описание" /></label>
      <nav aria-label="Область каталога"><button type="button" className={scope === 'hero' ? 'active' : ''} aria-pressed={scope === 'hero'} onClick={() => switchScope('hero')}>Героя</button><button type="button" className={scope === 'catalog' ? 'active' : ''} aria-pressed={scope === 'catalog'} onClick={() => switchScope('catalog')}>Весь каталог</button></nav>
      <nav aria-label="Фильтр по кругу">
        <button type="button" className={level === 'all' ? 'active' : ''} onClick={() => setLevel('all')}>Все</button>
        {levels.map((entry) => <button type="button" key={entry} className={level === entry ? 'active' : ''} onClick={() => setLevel(entry)}>{entry === 0 ? 'Заговоры' : entry}</button>)}
      </nav>
      <span aria-live="polite">{filtered.length} из {visibleSpells.length}</span>
    </div>
    <div className="spellbook-catalog-body">
      <div className="spellbook-catalog-list" aria-label="Список заклинаний">
        {filtered.map((spell) => {
          const active = selected?.id === spell.id
          const blockedReason = cleanReason(blockedReasonFor?.(spell) ?? (spell.componentAvailability?.available === false ? spell.componentAvailability.reason : null))
          return <article key={spell.id} className={`spellbook-card${active ? ' active' : ''}${blockedReason ? ' blocked' : ''}`}>
            <button type="button" className="spellbook-card-main" onClick={() => setSelectedId(spell.id)} aria-expanded={active}>
              <CombatIcon id={spell.id} kind="spell" hint={`${spell.name} ${spell.school ?? ''} ${spell.damageType ?? ''}`} size={48} priority={active} /><span><strong>{spell.name}</strong><small>{spellLevelLabel(spell.level)} · {spell.school || 'Школа не указана'}</small></span>
              <p>{readableSpellText(spell.description?.trim() || 'Описание отсутствует в каталоге.')}</p>
              {blockedReason && <em role="status">Недоступно для применения: {blockedReason}. Открыто для чтения.</em>}
            </button>
            {onPin && <button type="button" className="spellbook-card-pin" onClick={() => onPin(spell.id)} disabled={isPinDisabled?.(spell) ?? false} aria-pressed={pinned.has(spell.id)}>{pinned.has(spell.id) ? 'Закреплено' : 'Закрепить'}</button>}
          </article>
        })}
        {!filtered.length && <p className="spellbook-empty">По этому запросу заклинаний нет.</p>}
      </div>
      <div className="spellbook-catalog-detail" ref={detailPanelRef}>
        {selected ? <SpellDetail spell={selected} details={readerDetails[selected.id]} onSelect={onSelect} selectionDisabled={isSelectionDisabled?.(selected) ?? false} blockedReason={blockedReasonFor?.(selected)} /> : <p className="spellbook-empty">В каталоге нет карточек.</p>}
      </div>
    </div>
  </section>
}
