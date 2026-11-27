import '../../../fixtures-env.mjs'
// Эталоны `normalizeCommand` (`rules-engine.mjs`, 4579–4873) для `sk-rules`:
//
// 1. Команды корпуса паритета (если передан каталог корпуса): до 15 на тип,
//    состояние сведено к полям, которые читает нормализация
//    (`ruleset_id`, `state_version`).
// 2. Мусорные команды всех разрешённых типов и неизвестных (в том числе
//    ключей прототипа): случайные поля из обоих написаний (`actor_id` и
//    `actorId`…) с мусорными значениями — числа, строки с пробелами и
//    длинные, массивы, объекты, NFKC-символы.
// 3. Вход не объектом (`null`, строка, массив, число).
//
// `randomUUID` подменён счётчиком `uuid-1`, `uuid-2`… на каждый случай.
// Большой ответ хранится хешем строки `JSON.stringify`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-normalize-command.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? null

let seed = 0x0c0ffee5
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const sha = (text) => createHash('sha256').update(text).digest('hex')

function run(input, state) {
  let counter = 0
  globalThis.__SK_OPEN_COPY_UUID__ = () => `uuid-${++counter}`
  try {
    const command = E.normalizeCommand(input, state)
    const text = JSON.stringify(command)
    return text.length > 6_000 ? { expected_sha256: sha(text) } : { expected: JSON.parse(text) }
  } catch (error) {
    return { error: { name: error.name, code: error.code ?? null } }
  } finally {
    delete globalThis.__SK_OPEN_COPY_UUID__
  }
}

const cases = []

// 1. Корпус.
if (corpusDir && existsSync(corpusDir)) {
  const perType = new Map()
  const stateCache = new Map()
  const files = readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()
  for (const file of files) {
    for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      const type = String(record.command?.command_type ?? '?')
      const count = perType.get(type) ?? 0
      if (count >= 15) continue
      const text = JSON.stringify(record.command)
      if (text.length > 6_000) continue
      if (!stateCache.has(record.state)) {
        const full = JSON.parse(readFileSync(join(corpusDir, 'states', `${record.state}.json`), 'utf8'))
        stateCache.set(record.state, { ruleset_id: full.ruleset_id, state_version: full.state_version })
      }
      const state = stateCache.get(record.state)
      perType.set(type, count + 1)
      cases.push({ source: 'corpus', input: record.command, state, ...run(record.command, state) })
    }
  }
}

// 2. Мусор.
const longText = 'Длинная строка с пробелами   и\tтабуляцией\n'.repeat(8)
const nfkcText = 'ｆｕｌｌ　ｗｉｄｔｈ текст и ﬁ лигатура  '
const generic = [null, true, false, 0, 1, -1, 7, 1.5, 1e21, '', ' ', 'x', '  padded  ', '5', longText, nfkcText, ['a', 'a', ' b ', null, 3], { a: 1 }, [], [['x']]]
const special = {
  command_type: null,
  spell_id: ['longstrider', 'mass-cure-wounds', 'destructive-wave', 'chain-lightning', 'fire-bolt', 'magic-missile', 'cure-wounds', 7, null],
  spellId: ['longstrider', 'chain-lightning', 'bless'],
  target_ids: [['a', 'a'], ['a', 'b'], ['a', ' a'], ['', 'x'], 'a', null, [1, '1'], ['hero', 'goblin', 'hero']],
  targetIds: [['b', 'b'], ['c']],
  source_rule_ids: [[], ['srd_5_2_1:combat:damage'], ['dnd_5e_2014:combat:damage'], ['custom:rule', ' '], 'srd_5_2_1:x', null],
  sourceRuleIds: [['dnd_5e_2014:checks:ability-check'], []],
  stage: ['arrive', 'reveal', 'leave', null, 1],
  skill: ['persuasion', 'intimidation', 'stealth', 'athletics', 'ARCANA', 'Religion', null, 5],
  approach: ['force', 'hand', 'fair', 'cheat', 'watch', 'FORCE', null],
  intent: ['inspect', 'lockpick', 'take', 'pray', null, 3],
  stake_cp: [10, 50, 200, '50', 11, null, 'x'],
  stakeCp: [200, '10'],
  lines: [[], [{ item_instance_id: 'i-1', quantity: 2 }, { itemInstanceId: ' i-2 ', quantity: '3' }, null, ['x'], { quantity: 1 }, { item_instance_id: 'i-3', quantity: 1.5 }], 'x',
    Array.from({ length: 14 }, (_, index) => ({ item_instance_id: `i-${index}` }))],
  slab: ['short slab', 'x'.repeat(49_160), 42, null],
  quantity: [1, 3, '4', 1.5, -2, null, 'x', 1e16],
  expected_state_version: [0, 3, '3', 7, null, 'x', 1.5],
  expectedStateVersion: [3, '7'],
  force: [true, 'true', 1, false],
  sneak_attack: [true, 'yes'],
  sneakAttack: [true],
  preserve_layout: [true, 1],
  addressee_kind: ['npc', 'hero', null, 'very-long-addressee-kind-value'],
}
const fields = [
  'command_type', 'type', 'command_id', 'commandId', 'actor_id', 'actorId', 'target_id', 'targetId', 'spell_id', 'spellId', 'target_ids', 'targetIds',
  'source_rule_ids', 'sourceRuleIds', 'house_rule_id', 'houseRuleId', 'ruling_id', 'rulingId', 'merchant_id', 'merchantId', 'stock_id', 'stockId', 'item_id', 'itemId',
  'material_item_id', 'materialItemId', 'door_id', 'doorId', 'force', 'attack_mode', 'attackMode', 'attack_ability', 'attackAbility', 'sneak_attack', 'sneakAttack',
  'service_id', 'serviceId', 'action_id', 'actionId', 'quantity', 'request_fingerprint', 'difficulty', 'theme', 'seed', 'npc_id', 'npcId', 'encounter', 'scene_args', 'sceneArgs',
  'party_decision', 'partyDecision', 'option_id', 'dialogue_option', 'amount', 'catalog_id', 'armory_item', 'informant_id', 'choice', 'skill', 'reward_item',
  'reward_source_npc_id', 'stage', 'npc', 'captive_id', 'captiveId', 'container_id', 'containerId', 'recipient_id', 'recipientId', 'lines', 'beast_id', 'beastId', 'outcome',
  'resolution', 'region_id', 'regionId', 'stake_cp', 'stakeCp', 'approach', 'addressee_kind', 'addresseeKind', 'addressee_id', 'addresseeId', 'body', 'reply_draft',
  'reply_draft_tone', 'reply_provider', 'replacement_name', 'prop_id', 'propId', 'intent', 'location_id', 'locationId', 'slab', 'text', 'preserve_layout',
  'expected_state_version', 'expectedStateVersion', 'visibility', 'server_authoritative', 'campaign_id', 'extra_field',
]
const states = [
  { ruleset_id: 'srd_5_2_1', state_version: 0 }, { ruleset_id: 'dnd_5e_2014', state_version: 7 }, { state_version: 3 }, { ruleset_id: '', state_version: '4' },
  { ruleset_id: 'homebrew', state_version: 1.5 }, { ruleset_id: 5, state_version: 2 }, {}, { ruleset_id: 'dnd_5e_2014' },
]
const types = [...E.ALLOWED_COMMAND_TYPES, '', 'Unknown', 'constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']
for (const type of types) {
  for (let index = 0; index < 14; index += 1) {
    const input = {}
    const count = 2 + Math.floor(random() * 9)
    if (random() < 0.85) input[random() < 0.8 ? 'command_type' : 'type'] = type
    for (let field = 0; field < count; field += 1) {
      const key = pick(fields)
      if (key === 'command_type' || key === 'type') continue
      const pool = special[key] && random() < 0.75 ? special[key] : generic
      input[key] = pick(pool)
    }
    if (random() < 0.3) delete input.command_id
    else if (random() < 0.8) input.command_id = `cmd-${type}-${index}`
    const state = pick(states)
    cases.push({ source: 'garbage', input, state, ...run(input, state) })
  }
}

// 3. Вход не объектом.
for (const input of [null, 'abc', [1, 'MakeAttack'], 5, true, { type: 'MakeAttack', command_type: null }, { commandId: 'x', command_type: 'MakeAttack', actorId: 7, targetId: 'g' }]) {
  for (const state of [states[0], states[1]]) cases.push({ source: 'shape', input, state, ...run(input, state) })
}

const summary = { total: cases.length, errors: cases.filter((entry) => entry.error).length, hashed: cases.filter((entry) => entry.expected_sha256).length, corpus: cases.filter((entry) => entry.source === 'corpus').length }
writeFileSync(new URL('normalize-command.json', import.meta.url), `${JSON.stringify({ source_sha256: sourceSha256(), summary, cases })}\n`)
console.log('normalize-command.json:', JSON.stringify(summary))
