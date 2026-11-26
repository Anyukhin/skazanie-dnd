import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve('server/encounter-assembler.mjs'), 'utf8')
const themeBlock = source.slice(source.indexOf('const THEMES ='), source.indexOf('const SIZE_CLASS_BY_STAT_BLOCK'))
const ids = [...themeBlock.matchAll(/srd_5_2_1:([a-z0-9-]+)/gu)].map(match => match[1])
const scenario = JSON.parse(readFileSync(resolve('data/campaign-scenarios-v1.json'), 'utf8'))
const world = JSON.parse(readFileSync(resolve('data/campaign-worlds-v1.json'), 'utf8'))
const named = []
function walk(value) {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value) && typeof value.id === 'string' && /^astohan-/.test(value.id)
    && (value.creature_type || value.profile_id || value.challenge_rating)) named.push({ id: value.id, name: value.name_ru ?? value.name ?? value.id, creatureType: value.creature_type ?? null, profile: value.profile_id ?? null, size: value.size ?? null })
  for (const child of Object.values(value)) walk(child)
}
walk(world); walk(scenario)
for (const namedId of ['astohan-kaelan', 'astohan-sargat']) {
  const found = JSON.stringify(world).includes(`"id":"${namedId}"`) || JSON.stringify(world).includes(`"id": "${namedId}"`)
  if (found && !named.some(item => item.id === namedId)) named.push({ id: namedId, name: namedId === 'astohan-sargat' ? 'Саргат' : 'Каэлан Вердант', creatureType: namedId === 'astohan-sargat' ? 'dragon' : 'undead', profile: namedId === 'astohan-sargat' ? 'astohan:sargat-v1' : 'astohan:kaelan-v1', size: namedId === 'astohan-sargat' ? 'large' : 'medium' })
}
const unique = (values, key) => [...new Map(values.map(item => [key(item), item])).values()]
const themes = Object.fromEntries([...themeBlock.matchAll(/^\s{2}(\w+): \[([^\]]+)\]/gmu)].map(([, theme, value]) => [theme, [...value.matchAll(/'srd_5_2_1:([^']+)'/g)].map(match => match[1])]))
const roster = { generatedAt: new Date().toISOString(), themes, statBlocks: [...new Set(ids)].sort(), named: unique(named, item => item.id) }
mkdirSync(resolve('docs/reviews'), { recursive: true })
mkdirSync(resolve('tmp/astohan-survey'), { recursive: true })
writeFileSync(resolve('docs/reviews/astohan-enemy-roster.json'), JSON.stringify(roster, null, 2) + '\n')
const lines = ['# Враги и фигурки «Асстоханских равнин»', '', `В теме встреч собрано ${roster.statBlocks.length} статблоков. Именных существ мира — ${roster.named.length}. Runtime выбирает профиль по публичному имени и creature_type, а explicit modelKey сохраняет приоритет.`, '', '## Семейства встреч', '']
for (const [theme, entries] of Object.entries(themes)) lines.push(`- **${theme}** — ${entries.join(', ')}`)
lines.push('', '## Называемые существа', '')
for (const npc of roster.named) lines.push(`- ${npc.id} — ${npc.name}, ${npc.creatureType ?? 'unknown'}, ${npc.size ?? 'unknown'}`)
lines.push('', '## Визуальные маршруты', '', '- обычный skeleton, goblin, rat, spider, wasp, frog, snake и dragon используют локальные GLB;', '- owlbear, большие звери, орки, огры, рыцари, культисты и элементали получают публичный силуэтный акцент поверх общего профиля;', '- monstrosity, wyvern, couatl и undead-специфичные варианты подключаются отдельными семействами с собственными тестами;', '- неизвестный или замаскированный враг сохраняет нейтральную фигурку, чтобы модель не сообщала скрытую расу.')
writeFileSync(resolve('docs/reviews/astohan-enemy-models.md'), lines.join('\n') + '\n')
