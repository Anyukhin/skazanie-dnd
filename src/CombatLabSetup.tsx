import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { SerializedTacticalMap } from './types'
import { CombatLabBoard } from './CombatLabBoard'

export type ArenaMember = { source: 'hero' | 'class'; campaignId?: string; heroId?: string; classId?: string; level: number; x: number; y: number }
export type ArenaEnemy = { monsterId: string; x: number; y: number }
export type ArenaConfig = { mapId: string; party: ArenaMember[]; enemies: ArenaEnemy[] }
type Catalog = {
  heroes: { id: string; campaignId: string; name: string; className: string; level: number }[]
  classes: { id: string; name: string }[]
  monsters: { id: string; name: string; cr: string | number; hp: number; sourceUrl: string; image?: string; limitations?: string[] | string }[]
  maps: { id: string; name: string; cells: { x: number; y: number; type: string; difficult?: boolean }[]; width: number; height: number; map?: SerializedTacticalMap }[]
  limits: { party: number; enemies: number }
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
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/admin/combat-lab/catalog', { signal: abort.signal }).then(async (response) => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Не удалось загрузить каталог арены')
      return body as Catalog
    }).then((body) => {
      setCatalog(body); setClassChoice(body.classes[0]?.id ?? 'fighter'); setMonsterChoice(body.monsters[0]?.id ?? '')
      setConfig({ mapId: body.maps[0]?.id ?? '', party: [], enemies: [] })
    }).catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message) })
    return () => abort.abort()
  }, [])
  useEffect(() => { onChange(config.party.length && config.enemies.length && config.mapId ? config : null) }, [config, onChange])
  const map = catalog?.maps.find((item) => item.id === config.mapId)
  const labelParty = (member: ArenaMember) => member.source === 'hero'
    ? catalog?.heroes.find((hero) => hero.id === member.heroId && hero.campaignId === member.campaignId)?.name ?? 'Герой'
    : catalog?.classes.find((item) => item.id === member.classId)?.name ?? member.classId ?? 'Герой'
  const nextPosition = (side: 'party' | 'enemy', taken = [...config.party, ...config.enemies]) => {
    const candidates = [...(map?.cells ?? [])].filter((cell) => cell.type !== 'wall' && !taken.some((actor) => actor.x === cell.x && actor.y === cell.y))
      .sort((a, b) => (side === 'party' ? a.x - b.x : b.x - a.x) || a.y - b.y)
    return candidates[0] ? { x: candidates[0].x, y: candidates[0].y } : null
  }
  const addHero = (source: 'hero' | 'class') => {
    if (!catalog || config.party.length >= catalog.limits.party) return
    const position = nextPosition('party')
    if (!position) return setError('На карте не осталось свободных клеток')
    const hero = catalog.heroes.find((item) => `${item.campaignId}/${item.id}` === heroChoice)
    if (source === 'hero' && !hero) return
    const member: ArenaMember = source === 'hero' && hero ? { source, campaignId: hero.campaignId, heroId: hero.id, level: hero.level, ...position }
      : { source, classId: classChoice, level, ...position }
    setSelected(`party-${config.party.length}`)
    setConfig({ ...config, party: [...config.party, member] }); setError('')
  }
  const addEnemies = () => {
    if (!catalog || !monsterChoice) return
    if (!Number.isSafeInteger(quantity) || quantity < 1 || config.enemies.length + quantity > catalog.limits.enemies) return setError(`Врагов должно быть не больше ${catalog.limits.enemies}`)
    const enemies = [...config.enemies]
    for (let i = 0; i < quantity; i++) {
      const position = nextPosition('enemy', [...config.party, ...enemies])
      if (!position) return setError('На карте не осталось свободных клеток')
      enemies.push({ monsterId: monsterChoice, ...position })
    }
    setSelected(`enemy-${config.enemies.length}`); setConfig({ ...config, enemies }); setError('')
  }
  const place = (x: number, y: number) => {
    if (disabled || !selected) return
    if ([...config.party.map((actor, i) => ({ ...actor, id: `party-${i}` })), ...config.enemies.map((actor, i) => ({ ...actor, id: `enemy-${i}` }))].some((actor) => actor.id !== selected && actor.x === x && actor.y === y)) return setError('Эта клетка уже занята')
    const [side, rawIndex] = selected.split('-'); const index = Number(rawIndex)
    if (side === 'party') setConfig({ ...config, party: config.party.map((actor, i) => i === index ? { ...actor, x, y } : actor) })
    else setConfig({ ...config, enemies: config.enemies.map((actor, i) => i === index ? { ...actor, x, y } : actor) })
    setError('')
  }
  const monster = catalog?.monsters.find((item) => item.id === monsterChoice)
  return <div className="combat-lab-setup">
    {error && <p role="alert" className="combat-lab-error">{error}</p>}
    {!catalog ? <p>Загрузка героев, бестиария и карт…</p> : <>
      <fieldset disabled={disabled} className="combat-lab-roster-controls"><legend>Состав боя</legend>
        <div><h2>Отряд</h2><label>Герой из кампании<select value={heroChoice} onChange={(event) => setHeroChoice(event.target.value)}><option value="">Выберите героя</option>{catalog.heroes.map((hero) => <option key={`${hero.campaignId}/${hero.id}`} value={`${hero.campaignId}/${hero.id}`} disabled={config.party.some((member) => member.source === 'hero' && member.campaignId === hero.campaignId && member.heroId === hero.id)}>{hero.name} · {hero.className}, ур. {hero.level} · {hero.campaignId}</option>)}</select></label><button onClick={() => addHero('hero')} disabled={!heroChoice || config.party.length >= catalog.limits.party || config.party.some((member) => `${member.campaignId}/${member.heroId}` === heroChoice)}><Plus size={16} />Копировать героя</button><p className="combat-lab-note">Копия сохраняет уровень, снаряжение и выборы героя. Для сравнения уровней добавьте учебного героя.</p>
          <label>Учебный герой<select value={classChoice} onChange={(event) => setClassChoice(event.target.value)}>{catalog.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Уровень<input type="number" min="1" max="12" value={level} onChange={(event) => setLevel(Number(event.target.value))} /></label><button onClick={() => addHero('class')} disabled={!Number.isInteger(level) || level < 1 || level > 12 || config.party.length >= catalog.limits.party}><Plus size={16} />Добавить в отряд</button>
        </div>
        <div><h2>Противники</h2><label>Поиск в бестиарии<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Название существа" /></label><label>Существо<select value={monsterChoice} onChange={(event) => setMonsterChoice(event.target.value)}>{catalog.monsters.filter((item) => !search || item.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')) || item.id === monsterChoice).map((item) => <option key={item.id} value={item.id}>{item.name} · ПО {item.cr} · {item.hp} ОЗ</option>)}</select></label><label>Количество<input type="number" min="1" max={catalog.limits.enemies} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label><button onClick={addEnemies} disabled={!monsterChoice || config.enemies.length >= catalog.limits.enemies}><Plus size={16} />Добавить противников</button>
          {monster?.limitations && <p className="combat-lab-note">{Array.isArray(monster.limitations) ? monster.limitations.join(' ') : monster.limitations}</p>}
          {monster?.sourceUrl && <a href={monster.sourceUrl} target="_blank" rel="noreferrer">Карточка существа на dnd.su</a>}
        </div>
      </fieldset>
      <div className="combat-lab-placement">
        <div><label>Карта<select disabled={disabled} value={config.mapId} onChange={(event) => { setConfig({ mapId: event.target.value, party: [], enemies: [] }); setSelected(null) }}>{catalog.maps.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.width} × {item.height}</option>)}</select></label><p className="combat-lab-note">Выберите участника в списке и нажмите свободную клетку. Смена карты очищает состав.</p>
          <ul className="combat-lab-placement-list">{config.party.map((actor, index) => <li key={`party-${index}`}><button disabled={disabled} aria-pressed={selected === `party-${index}`} onClick={() => setSelected(`party-${index}`)}>{index + 1}. {labelParty(actor)} · ур. {actor.level} ({actor.x}, {actor.y})</button><button disabled={disabled} aria-label={`Убрать героя ${index + 1}`} onClick={() => { setConfig({ ...config, party: config.party.filter((_, i) => i !== index) }); setSelected(null) }}><Trash2 size={16} /></button></li>)}{config.enemies.map((actor, index) => <li key={`enemy-${index}`}><button disabled={disabled} aria-pressed={selected === `enemy-${index}`} onClick={() => setSelected(`enemy-${index}`)}>{config.party.length + index + 1}. {catalog.monsters.find((item) => item.id === actor.monsterId)?.name} ({actor.x}, {actor.y})</button><button disabled={disabled} aria-label={`Убрать противника ${index + 1}`} onClick={() => { setConfig({ ...config, enemies: config.enemies.filter((_, i) => i !== index) }); setSelected(null) }}><Trash2 size={16} /></button></li>)}</ul>
          <p>Отряд: {config.party.length}/{catalog.limits.party}. Противники: {config.enemies.length}/{catalog.limits.enemies}.</p>
        </div>
        {map && <CombatLabBoard map={map.map} cells={map.cells} actors={[...config.party.map((actor, i) => ({ ...actor, id: `party-${i}`, name: labelParty(actor), image: actor.classId ? `/assets/ui/class-icons/${actor.classId}.webp` : undefined, side: 'party' as const, hp: 1, maxHp: 1 })), ...config.enemies.map((actor, i) => ({ ...actor, id: `enemy-${i}`, name: catalog.monsters.find((item) => item.id === actor.monsterId)?.name ?? 'Противник', image: catalog.monsters.find((item) => item.id === actor.monsterId)?.image, side: 'enemy' as const, hp: 1, maxHp: 1 }))]} activeActorId={selected} onPlace={disabled ? undefined : place} />}
      </div>
    </>}
  </div>
}
