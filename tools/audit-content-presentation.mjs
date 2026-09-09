// Проверяет оформление существующих каталогов, не меняя кампании или поддержку правил.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { canonicalCombatSpellFor, spellCatalogInfo } from '../server/combat-spells.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { loadDndsu2014Content } from '../server/dndsu-2014-content.mjs'
import { monsterCatalogEntry } from '../server/combat-lab-monsters.mjs'
import { resolveItemImagePath } from './build-item-manifest.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SPELLS = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8')).spells
const STARTER_ITEMS = JSON.parse(readFileSync(new URL('../data/starter-item-presentation.json', import.meta.url), 'utf8')).items

export function isReadableDescription(value, minimumLength = 50) {
  const text = String(value ?? '').trim()
  return text.length >= minimumLength && /[а-яё]{3}/iu.test(text)
    && !/^(?:buff|summon|utility|особый или внебоевой эффект)$|\b(?:cube|sphere|cone|acid|bludgeoning)\b/iu.test(text)
}

function countStatuses(records, field) {
  return records.reduce((counts, record) => {
    const status = String(record[field] ?? 'unspecified')
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
}

export async function auditContentPresentation() {
  const reference = await loadDndsu2014Content()
  const problems = []
  function inspect(records, kind, { description, image, minimumLength = 50 } = {}) {
    const descriptions = description ? records.filter(record => isReadableDescription(description(record), minimumLength)).length : null
    if (description) for (const record of records) {
      if (!isReadableDescription(description(record), minimumLength)) problems.push(`${kind}:${record.id ?? record.catalog_id}: отсутствует содержательное русское описание`)
    }
    let images = null
    if (image) {
      images = 0
      for (const record of records) {
        const path = image(record)
        if (path?.startsWith('/assets/') && existsSync(resolve(ROOT, 'public', path.slice(1)))) images++
        else problems.push(`${kind}:${record.id ?? record.catalog_id}: нет локального изображения`)
      }
    }
    return { entries: records.length, ...(descriptions != null ? { descriptions } : {}), ...(images != null ? { images } : {}) }
  }
  const spells = SPELLS.map(spell => canonicalCombatSpellFor(spell.id))
  const items = Object.values(ITEM_CATALOG)
  const monsters = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST).map(([id, record]) => ({ id, ...record }))
  const catalogs = {
    spells: { ...inspect(spells, 'spell', { description: spell => spell.description, image: spell => `/assets/ui/action-icons/${spell.id}.png` }), levels: '0–6', mechanics: spellCatalogInfo() },
    runtime_items: { ...inspect(items, 'item', { description: item => item.description, image: resolveItemImagePath }), mechanics: countStatuses(items, 'mechanics_status'), ruleset_id: 'srd_5_2_1' },
    starter_items: { ...inspect(Object.entries(STARTER_ITEMS).map(([name, item]) => ({ id: name, ...item })), 'starter-item', { description: item => item.description, image: item => item.image, minimumLength: 20 }), mechanics: 'presentation_only', includes_nested_items: 1 },
    runtime_monsters: { ...inspect(monsters, 'monster', { image: monster => monster.image }), ruleset_id: 'srd_5_2_1' },
    reference_2014_items: { ...inspect(reference.magicItems, 'reference-item', { description: item => item.summary_ru }), mechanics: 'data_only' },
    reference_2014_monsters: { ...inspect(reference.monsters, 'reference-monster', { description: monster => monster.lore.summary_ru, image: monster => monsterCatalogEntry(monster).image }), mechanics: 'partial_arena_adapter' },
  }
  return { ok: problems.length === 0, ...catalogs, problems }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await auditContentPresentation()
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}
