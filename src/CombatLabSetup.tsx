import { useEffect, useRef, useState } from 'react'
import { Plus, Shuffle, Trash2 } from 'lucide-react'
import type { SerializedTacticalMap } from './types'
import { CombatLabBoard } from './CombatLabBoard'
import { labRequest } from './combat-lab-client'
import { MonsterStatBlock, type MonsterCatalogEntry } from './MonsterStatBlock'

export type ArenaMember = { source: 'hero' | 'class'; campaignId?: string; heroId?: string; classId?: string; level: number; x: number; y: number }
export type ArenaEnemy = { monsterId: string; x: number; y: number }
export type ArenaConfig = { mapId: string; party: ArenaMember[]; enemies: ArenaEnemy[] }
type Difficulty = 'easy' | 'medium' | 'hard' | 'deadly'
type Assessment = { difficulty: Difficulty | 'trivial'; rawXp: number; adjustedXp: number; multiplier: number; thresholds: Record<Difficulty, number>; partyLevels: number[]; warnings: string[]; requestedDifficulty?: Difficulty; matched?: boolean }
type ArenaMap = { id: string; name: string; description?: string; cells: { x: number; y: number; type: string; difficult?: boolean; passable?: boolean }[]; width: number; height: number; map?: SerializedTacticalMap }
type Catalog = {
  heroes: { id: string; campaignId: string; name: string; className: string; level: number }[]
  classes: { id: string; name: string }[]
  monsters: MonsterCatalogEntry[]
  maps: ArenaMap[]
  encounterThemes?: { id: string; name: string }[]
  limits: { party: number; enemies: number }
}
const DIFFICULTIES = { trivial: 'Ниже лёгкой', easy: 'Лёгкая', medium: 'Средняя', hard: 'Тяжёлая', deadly: 'Смертельная' }
const TIERS: Difficulty[] = ['easy', 'medium', 'hard', 'deadly']
const xp = (value: number) => value.toLocaleString('ru-RU')
const SETUP_KEY = 'skazanie-combat-lab-setup-v1'
const canPlace = (cell: ArenaMap['cells'][number]) => cell.passable ?? !['wall', 'water', 'void'].includes(cell.type)
function savedConfig(catalog: Catalog): ArenaConfig | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SETUP_KEY) ?? 'null') as ArenaConfig | null
    const map = catalog.maps.find((item) => item.id === saved?.mapId)
    if (!saved || !map || !Array.isArray(saved.party) || !Array.isArray(saved.enemies)
      || saved.party.length > catalog.limits.party || saved.enemies.length > catalog.limits.enemies) return null
    if (!saved.party.every((member) => member && Number.isInteger(member.level) && member.level >= 1 && member.level <= 12 && (member.source === 'class'
      ? catalog.classes.some((item) => item.id === member.classId)
      : member.source === 'hero' && catalog.heroes.some((item) => item.id === member.heroId && item.campaignId === member.campaignId)))) return null
    if (!saved.enemies.every((member) => member && catalog.monsters.some((item) => item.id === member.monsterId))) return null
    const actors = [...saved.party, ...saved.enemies]
    if (!actors.every((actor) => map.cells.some((cell) => canPlace(cell) && cell.x === actor.x && cell.y === actor.y))) return null
    if (new Set(actors.map((actor) => actor.x + ',' + actor.y)).size !== actors.length) return null
    return { ...saved, party: saved.party.map((member) => member.source === 'hero'
      ? { ...member, level: catalog.heroes.find((item) => item.id === member.heroId && item.campaignId === member.campaignId)!.level }
      : member) }
  } catch { return null }
}
function freePosition(map: ArenaMap | undefined, side: 'party' | 'enemy', taken: { x: number; y: number }[]) {
  const cell = [...(map?.cells ?? [])].filter((c) => canPlace(c) && !taken.some((actor) => actor.x === c.x && actor.y === c.y))
    .sort((a, b) => (side === 'party' ? a.x - b.x : b.x - a.x) || Math.abs(a.y - (map?.height ?? 0) / 2) - Math.abs(b.y - (map?.height ?? 0) / 2))[0]
  return cell ? { x: cell.x, y: cell.y } : null
}

export function CombatLabSetup({ disabled, onChange }: { disabled: boolean; onChange: (config: ArenaConfig | null) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [config, setConfig] = useState<ArenaConfig>({ mapId: '', party: [], enemies: [] })
  const [heroChoice, setHeroChoice] = useState('')
  const [classChoice, setClassChoice] = useState('fighter')
  const [level, setLevel] = useState(5)
  const [monsterChoice, setMonsterChoice] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [theme, setTheme] = useState('generic')
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [assessmentError, setAssessmentError] = useState('')
  const [assessing, setAssessing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationNotice, setGenerationNotice] = useState<{ config: ArenaConfig; text: string } | null>(null)
  const selectionSeed = useRef(1)
  const generationRequest = useRef<AbortController | null>(null)
  const locked = disabled || generating
  useEffect(() => () => generationRequest.current?.abort(), [])
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    void labRequest<Catalog>('/api/admin/combat-lab/catalog', { signal: abort.signal }).then((body) => {
      setCatalog(body); setMonsterChoice(body.monsters[0]?.id ?? '')
      setConfig(savedConfig(body) ?? { mapId: body.maps[0]?.id ?? '', party: [], enemies: [] })
    }).catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message) })
    return () => abort.abort()
  }, [catalogAttempt])
  useEffect(() => {
    if (!catalog || !config.mapId) return
    try { sessionStorage.setItem(SETUP_KEY, JSON.stringify(config)) } catch { /* закрытое хранилище не мешает настройке */ }
  }, [catalog, config])
  useEffect(() => { onChange(!generating && config.party.length && config.enemies.length && config.mapId ? config : null) }, [config, generating, onChange])
  useEffect(() => {
    setAssessment(null); setAssessmentError('')
    if (!config.party.length) { setAssessing(false); return }
    const abort = new AbortController()
    setAssessing(true)
    const timer = setTimeout(() => {
      void labRequest<{ assessment: Assessment }>('/api/admin/combat-lab/encounter/assess', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }), signal: abort.signal,
      }).then((body) => { if (!abort.signal.aborted) setAssessment(body.assessment) })
        .catch((reason: Error) => { if (!abort.signal.aborted) setAssessmentError(reason.message) })
        .finally(() => { if (!abort.signal.aborted) setAssessing(false) })
    }, 200)
    return () => { clearTimeout(timer); abort.abort() }
  }, [config])
  const map = catalog?.maps.find((item) => item.id === config.mapId)
  const labelParty = (member: ArenaMember) => member.source === 'hero'
    ? catalog?.heroes.find((hero) => hero.id === member.heroId && hero.campaignId === member.campaignId)?.name ?? 'Герой'
    : catalog?.classes.find((item) => item.id === member.classId)?.name ?? 'Герой'
  const addHero = (source: 'hero' | 'class') => {
    if (locked || !catalog || config.party.length >= catalog.limits.party) return
    const position = freePosition(map, 'party', [...config.party, ...config.enemies])
    if (!position) return setError('На карте не осталось свободных клеток')
    const hero = catalog.heroes.find((item) => item.campaignId + '/' + item.id === heroChoice)
    if (source === 'hero' && (!hero || config.party.some((item) => item.heroId === hero.id && item.campaignId === hero.campaignId))) return
    if (source === 'class' && (!Number.isInteger(level) || level < 1 || level > 12)) return
    const member: ArenaMember = source === 'hero' && hero ? { source, campaignId: hero.campaignId, heroId: hero.id, level: hero.level, ...position }
      : { source, classId: classChoice, level, ...position }
    setSelected('party-' + config.party.length)
    setConfig({ ...config, party: [...config.party, member] }); setError('')
  }
  const addStandardParty = () => {
    if (locked || config.party.length || !Number.isInteger(level) || level < 1 || level > 12) return
    const party: ArenaMember[] = []
    for (const classId of ['fighter', 'rogue', 'cleric', 'wizard']) {
      const position = freePosition(map, 'party', [...party, ...config.enemies])
      if (!position) return setError('На карте не осталось свободных клеток')
      party.push({ source: 'class', classId, level, ...position })
    }
    setConfig({ ...config, party }); setError('')
  }
  const addEnemies = () => {
    if (locked || !catalog || !monsterChoice) return
    if (!Number.isSafeInteger(quantity) || quantity < 1 || config.enemies.length + quantity > catalog.limits.enemies) return setError('Превышен допустимый состав противников')
    const enemies = [...config.enemies]
    for (let i = 0; i < quantity; i++) {
      const position = freePosition(map, 'enemy', [...config.party, ...enemies])
      if (!position) return setError('На карте не осталось свободных клеток')
      enemies.push({ monsterId: monsterChoice, ...position })
    }
    setSelected('enemy-' + config.enemies.length); setConfig({ ...config, enemies }); setError('')
  }
  const changeMap = (mapId: string) => {
    const next = catalog?.maps.find((item) => item.id === mapId)
    if (locked || !next) return
    const placed: { x: number; y: number }[] = []
    const relocate = <T extends { x: number; y: number }>(actor: T, side: 'party' | 'enemy') => {
      const position = freePosition(next, side, placed)
      if (!position) throw new Error('На этой карте недостаточно места для состава')
      placed.push(position); return { ...actor, ...position }
    }
    try {
      setConfig({ mapId, party: config.party.map((actor) => relocate(actor, 'party')), enemies: config.enemies.map((actor) => relocate(actor, 'enemy')) })
      setError(''); setSelected(null)
    } catch (reason) { setError((reason as Error).message) }
  }
  const generate = async () => {
    if (locked || !config.party.length) return
    const abort = new AbortController(); generationRequest.current = abort
    setGenerating(true); setError('')
    try {
      const result = await labRequest<{ config: ArenaConfig; assessment: Assessment }>('/api/admin/combat-lab/encounter/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, difficulty, theme, seed: selectionSeed.current++ }), signal: abort.signal,
      })
      if (!abort.signal.aborted) {
        setConfig(result.config); setSelected(null)
        setGenerationNotice(result.assessment.matched === false ? { config: result.config, text: `В выбранном наборе нет точного совпадения. Подобрана опасность: ${DIFFICULTIES[result.assessment.difficulty].toLocaleLowerCase('ru')}.` } : null)
      }
    } catch (reason) { if (!abort.signal.aborted) setError((reason as Error).message) }
    finally { if (!abort.signal.aborted) setGenerating(false) }
  }
  const place = (x: number, y: number) => {
    if (locked || !selected || !map?.cells.some((cell) => cell.x === x && cell.y === y && canPlace(cell))) return
    const actors = [...config.party.map((actor, i) => ({ ...actor, id: 'party-' + i })), ...config.enemies.map((actor, i) => ({ ...actor, id: 'enemy-' + i }))]
    if (actors.some((actor) => actor.id !== selected && actor.x === x && actor.y === y)) return setError('Эта клетка уже занята')
    const [side, rawIndex] = selected.split('-'); const index = Number(rawIndex)
    if (side === 'party') setConfig({ ...config, party: config.party.map((actor, i) => i === index ? { ...actor, x, y } : actor) })
    else setConfig({ ...config, enemies: config.enemies.map((actor, i) => i === index ? { ...actor, x, y } : actor) })
    setError('')
  }
  const filteredMonsters = (catalog?.monsters ?? []).filter((item) => item.name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
  const monster = filteredMonsters.find((item) => item.id === monsterChoice)
  const chosenMonsters = (catalog?.monsters ?? []).filter((item) => config.enemies.some((enemy) => enemy.monsterId === item.id))
  const levelValid = Number.isInteger(level) && level >= 1 && level <= 12
  return <div className="combat-lab-setup">
    {error && <p role="alert" className="combat-lab-error">{error}</p>}
    {!catalog ? <p>{error ? <button onClick={() => setCatalogAttempt((value) => value + 1)}>Повторить загрузку каталога</button> : 'Загрузка героев, бестиария и карт…'}</p> : <div className="combat-lab-workspace">
      <div className="combat-lab-rosters">
        <fieldset disabled={locked}><legend>Отряд <span>{config.party.length} / {catalog.limits.party}</span></legend>
          <div className="combat-lab-inline"><label>Учебный герой<select value={classChoice} onChange={(event) => setClassChoice(event.target.value)}>{catalog.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Уровень<input type="number" min="1" max="12" value={level} onChange={(event) => setLevel(Number(event.target.value))} /></label></div>
          <div className="combat-lab-inline-actions"><button onClick={() => addHero('class')} disabled={!levelValid || config.party.length >= catalog.limits.party}><Plus size={16} />Добавить героя</button>
            {!config.party.length && <button onClick={addStandardParty} disabled={!levelValid}>Собрать четырёх</button>}</div>
          {!config.party.length && <p className="combat-lab-note">Воин, плут, жрец и волшебник выбранного уровня.</p>}
          <details className="combat-lab-import"><summary>Копировать героя кампании</summary>
            {catalog.heroes.length ? <><label>Герой из кампании<select value={heroChoice} onChange={(event) => setHeroChoice(event.target.value)}><option value="">Выберите героя</option>{catalog.heroes.map((hero) => <option key={hero.campaignId + '/' + hero.id} value={hero.campaignId + '/' + hero.id} disabled={config.party.some((member) => member.heroId === hero.id && member.campaignId === hero.campaignId)}>{hero.name}, {hero.className}, ур. {hero.level} ({hero.campaignId})</option>)}</select></label><button onClick={() => addHero('hero')} disabled={!heroChoice || config.party.length >= catalog.limits.party || config.party.some((member) => member.campaignId + '/' + member.heroId === heroChoice)}>Копировать героя</button><p className="combat-lab-note">Копия начинает с полными ОЗ. Уровень, снаряжение и выбор заклинаний сохраняются.</p></> : <p className="combat-lab-note">В кампаниях редакции 2014 пока нет доступных героев.</p>}
          </details>
          <ul className="combat-lab-placement-list">{config.party.map((actor, index) => <li key={'party-' + index}><button aria-pressed={selected === 'party-' + index} onClick={() => setSelected('party-' + index)}><span>{index + 1}. {labelParty(actor)}</span><span className="combat-lab-note">Ур. {actor.level}</span></button><button aria-label={'Убрать героя ' + (index + 1)} onClick={() => { setConfig({ ...config, party: config.party.filter((_, i) => i !== index) }); setSelected(null) }}><Trash2 size={16} /></button></li>)}</ul>
        </fieldset>
        <fieldset disabled={locked}><legend>Противники <span>{config.enemies.length} / {catalog.limits.enemies}</span></legend>
          {!config.enemies.length && <p className="combat-lab-note">Подберите стычку для отряда или добавьте врагов из бестиария.</p>}
          <ul className="combat-lab-placement-list">{config.enemies.map((actor, index) => {
            const entry = catalog.monsters.find((item) => item.id === actor.monsterId)
            return <li key={'enemy-' + index}><button aria-pressed={selected === 'enemy-' + index} onClick={() => setSelected('enemy-' + index)}><span>{config.party.length + index + 1}. {entry?.name}</span><span className="combat-lab-note">ПО {entry?.cr}</span></button><button aria-label={'Убрать противника ' + (index + 1)} onClick={() => { setConfig({ ...config, enemies: config.enemies.filter((_, i) => i !== index) }); setSelected(null) }}><Trash2 size={16} /></button></li>
          })}</ul>
          {chosenMonsters.length > 0 && <details><summary>Способности и ограничения противников</summary>{chosenMonsters.map((item) => <div key={item.id}><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.name}</a><p className="combat-lab-note">{Array.isArray(item.limitations) ? item.limitations.join(' ') : item.limitations || 'Боевые действия статблока поддержаны.'}</p></div>)}</details>}
          <details className="combat-lab-bestiary"><summary>Бестиарий 2014 — {catalog.monsters.length} существ</summary>
            <label>Поиск в бестиарии<input type="search" value={search} onChange={(event) => { const value = event.target.value; setSearch(value); const match = catalog.monsters.find((item) => item.name.toLocaleLowerCase('ru').includes(value.trim().toLocaleLowerCase('ru'))); setMonsterChoice(match?.id ?? '') }} placeholder="Название существа" /></label>
            <label>Существо<select value={monster?.id ?? ''} onChange={(event) => setMonsterChoice(event.target.value)} disabled={!filteredMonsters.length}>{!filteredMonsters.length && <option value="">Ничего не найдено</option>}{filteredMonsters.map((item) => <option key={item.id} value={item.id}>{item.name} — ПО {item.cr}</option>)}</select></label>
            {monster && <div className="combat-lab-monster-detail">{(monster.images?.[0] ?? monster.image) && <img src={monster.images?.[0] ?? monster.image} alt={monster.name} />}<div><strong>{monster.name}</strong><p>ПО {monster.cr}, {monster.hp} ОЗ{monster.ac ? ', КД ' + monster.ac : ''}</p><a href={monster.sourceUrl} target="_blank" rel="noreferrer">Статблок на dnd.su</a></div></div>}
            {monster?.statBlock && <details className="combat-lab-statblock-details"><summary>Характеристики и умения</summary><MonsterStatBlock monster={monster} /></details>}
            <div className="combat-lab-inline"><label>Количество<input type="number" min="1" max={Math.max(1, catalog.limits.enemies - config.enemies.length)} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label><button onClick={addEnemies} disabled={!monster || !Number.isInteger(quantity) || quantity < 1 || config.enemies.length + quantity > catalog.limits.enemies}><Plus size={16} />Добавить</button></div>
            {monster?.limitations && <p className="combat-lab-note">{Array.isArray(monster.limitations) ? monster.limitations.join(' ') : monster.limitations}</p>}
          </details>
        </fieldset>
      </div>
      <div className="combat-lab-field">
        <label>Карта<select disabled={locked} value={config.mapId} onChange={(event) => changeMap(event.target.value)}>{catalog.maps.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.width} × {item.height}</option>)}</select></label>
        {map?.description && <p className="combat-lab-note">{map.description}</p>}
        {map && <CombatLabBoard preview map={map.map} cells={map.cells} actors={[...config.party.map((actor, i) => ({ ...actor, id: 'party-' + i, name: labelParty(actor), image: actor.classId ? '/assets/ui/class-icons/' + actor.classId + '.webp' : undefined, side: 'party' as const, hp: 1, maxHp: 1 })), ...config.enemies.map((actor, i) => ({ ...actor, id: 'enemy-' + i, name: catalog.monsters.find((item) => item.id === actor.monsterId)?.name ?? 'Противник', image: catalog.monsters.find((item) => item.id === actor.monsterId)?.image, side: 'enemy' as const, hp: 1, maxHp: 1 }))]} activeActorId={selected} onPlace={locked ? undefined : place} />}
        <p className="combat-lab-note">Выберите участника, затем свободную клетку. При смене карты состав сохраняется и расставляется заново.</p>
        <fieldset disabled={locked} className="combat-lab-encounter"><legend>Опасность стычки</legend>
          {catalog.encounterThemes && <label className="combat-lab-theme">Противники для подбора<select value={theme} onChange={(event) => setTheme(event.target.value)}>{catalog.encounterThemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <div className="combat-lab-inline"><label>Желаемая опасность<select value={difficulty} onChange={(event) => setDifficulty(event.target.value as Difficulty)}>{TIERS.map((item) => <option key={item} value={item}>{DIFFICULTIES[item]}</option>)}</select></label><button className="combat-lab-primary" onClick={() => void generate()} disabled={!config.party.length}><Shuffle size={16} />{generating ? 'Подбираю…' : config.enemies.length ? 'Подобрать другой состав' : 'Подобрать стычку'}</button></div>
          <p className="combat-lab-note">Подбор заменяет противников; отряд и карта сохраняются.</p>
          {generationNotice?.config === config && <p className="combat-lab-warning" role="status">{generationNotice.text}</p>}
          <div aria-live="polite" className="combat-lab-assessment">
            {!config.party.length ? <p>Добавьте героев для расчёта.</p> : assessing ? <p>Расчёт опасности…</p> : assessment && <>
              <p className={'combat-lab-danger ' + assessment.difficulty}><strong>{config.enemies.length ? DIFFICULTIES[assessment.difficulty] : 'Противники не выбраны'}</strong>{config.enemies.length > 0 && <span>{xp(assessment.adjustedXp)} скорректированного опыта</span>}</p>
              <dl className="combat-lab-thresholds">{TIERS.map((item) => <div key={item}><dt>{DIFFICULTIES[item]}</dt><dd>{xp(assessment.thresholds[item])}</dd></div>)}</dl>
              {config.enemies.length > 0 && <p className="combat-lab-note">Опыт существ {xp(assessment.rawXp)} × {assessment.multiplier} за численность. Множитель влияет на оценку, а не на награду.</p>}
              {assessment.warnings.map((warning, i) => <p key={i} className="combat-lab-warning">{warning}</p>)}
            </>}
            {assessmentError && <p className="combat-lab-error" role="alert">{assessmentError}</p>}
          </div>
          <p className="combat-lab-note">Оценка D&D 2014 по уровням и опыту. Снаряжение, тактика, рельеф и частичная поддержка способностей могут изменить исход.</p>
        </fieldset>
      </div>
    </div>}
  </div>
}
