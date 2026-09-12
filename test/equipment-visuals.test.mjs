import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EQUIPMENT_ITEM_VISUALS,
  EQUIPMENT_VISUAL_SCHEMA_VERSION,
  itemVisualForCatalogId,
  modelKeysForEquipmentSlot,
  normalizePublicLoadout,
  publicLoadoutForItems,
} from '../server/equipment-visuals.mjs'
import { normalizeAttackVisual } from '../server/actor-appearance.mjs'
import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'

test('все 61 экипируемая каталожная карточка имеет стабильную модель и слот', () => {
  const equippable = Object.values(ITEM_CATALOG).filter((entry) => entry.lifecycle?.equippable === true)
  assert.equal(equippable.length, 61)
  assert.equal(Object.keys(EQUIPMENT_ITEM_VISUALS).length, equippable.length)
  for (const entry of equippable) {
    const visual = itemVisualForCatalogId(entry.catalog_id)
    assert.ok(visual, entry.catalog_id)
    assert.equal(visual.slot, entry.equip?.slot ?? entry.lifecycle?.equip_slot, entry.catalog_id)
    assert.ok(visual.model_key, entry.catalog_id)
  }
  assert.equal(itemVisualForCatalogId('srd_5_2_1:longsword-plus-1').model_key, 'longsword')
  assert.equal(itemVisualForCatalogId('srd_5_2_1:adamantine-chain-mail').model_key, 'armor-chainmail')
  assert.equal(itemVisualForCatalogId('srd_5_2_1:flame-tongue-longsword').variant, 'flaming')
  assert.equal(EQUIPMENT_VISUAL_SCHEMA_VERSION, 2)
})

test('публичная loadout строится по надетым предметам и magic-вариантам', () => {
  const loadout = publicLoadoutForItems([
    { id: 'plate', catalog_id: 'srd_5_2_1:plate-armor', equipped: true },
    { id: 'flame', catalog_id: 'srd_5_2_1:flame-tongue-longsword', equipped: true, activated: true },
    { id: 'shield', catalog_id: 'srd_5_2_1:shield', equipped: true },
    { id: 'cloak', catalog_id: 'srd_5_2_1:cloak-of-protection', equipped: true },
    { id: 'ring', catalog_id: 'srd_5_2_1:ring-of-protection', equipped: true },
    { id: 'brooch', catalog_id: 'srd_5_2_1:brooch-of-shielding', equipped: false },
  ])
  assert.deepEqual(loadout, {
    body: { model_key: 'armor-plate' },
    main_hand: { model_key: 'longsword', variant: 'flaming' },
    off_hand: { model_key: 'shield' },
    cloak: { model_key: 'cloak', variant: 'enchanted' },
    'ring-protection': { model_key: 'ring', variant: 'enchanted' },
  })
})

test('неидентифицированная магия не раскрывает вариант, а flaming виден только при активации', () => {
  assert.deepEqual(publicLoadoutForItems([
    { id: 'unknown-flame', catalog_id: 'srd_5_2_1:flame-tongue-longsword', equipped: true, identified: false, activated: true },
    { id: 'unknown-mail', catalog_id: 'srd_5_2_1:adamantine-chain-mail', equipped: true, identified: false },
  ]), { main_hand: { model_key: 'longsword' }, body: { model_key: 'armor-chainmail' } })
  assert.deepEqual(publicLoadoutForItems([
    { id: 'known-flame-off', catalog_id: 'srd_5_2_1:flame-tongue-longsword', equipped: true, identified: true, activated: false },
  ]), { main_hand: { model_key: 'longsword', variant: 'enchanted' } })
  assert.deepEqual(publicLoadoutForItems([
    { id: 'known-flame-on', catalog_id: 'srd_5_2_1:flame-tongue-longsword', equipped: true, identified: true, activated: true },
  ]), { main_hand: { model_key: 'longsword', variant: 'flaming' } })
})

test('скрытые предметы не попадают в loadout, а неизвестный надетый предмет даёт null', () => {
  const loadout = publicLoadoutForItems([
    { id: 'hidden', catalog_id: 'srd_5_2_1:plate-armor', equipped: true, visibility: 'gm_only' },
    { id: 'custom', type: 'weapon', name: 'Древний клинок', combat: { kind: 'melee' }, equipped: true },
    { id: 'legacy', type: 'weapon', name: 'Длинный меч', equipped: true },
  ])
  assert.deepEqual(loadout, { main_hand: null })
})

test('legacy-имя сопоставляется только при точном совпадении, без fuzzy-модели', () => {
  assert.deepEqual(publicLoadoutForItems([
    { id: 'exact', type: 'weapon', name: 'Длинный меч', equipped: true },
  ]), { main_hand: { model_key: 'longsword' } })
  assert.deepEqual(publicLoadoutForItems([
    { id: 'ambiguous', type: 'weapon', name: 'Меч с красной руной', combat: { kind: 'melee' }, equipped: true },
  ]), { main_hand: null })
  assert.deepEqual(publicLoadoutForItems([
    { id: 'bow', type: 'weapon', name: 'Длинный лук', equipped: true },
  ]), { main_hand: { model_key: 'longbow' } })
})

test('дубликаты одного слота закрываются null, а нормализатор режет лишние поля и URL', () => {
  const duplicate = publicLoadoutForItems([
    { id: 'one', catalog_id: 'srd_5_2_1:longsword', equipped: true },
    { id: 'two', catalog_id: 'srd_5_2_1:dagger', equipped: true },
  ])
  assert.deepEqual(duplicate, { main_hand: null })

  assert.deepEqual(normalizePublicLoadout({
    main_hand: { model_key: 'longsword', variant: 'flaming', item_id: 'secret' },
    body: { model_key: 'armor-plate', variant: 'adamantine' },
    off_hand: { model_key: '../secret.glb' },
    cloak: { model_key: 'ring' },
    url: 'https://private.invalid/model.glb',
  }), {
    main_hand: { model_key: 'longsword', variant: 'flaming' },
    body: { model_key: 'armor-plate', variant: 'adamantine' },
    off_hand: null,
    cloak: null,
  })
  assert.ok(modelKeysForEquipmentSlot('main_hand').includes('longsword'))
  assert.deepEqual(modelKeysForEquipmentSlot('unknown'), [])
})

test('Equip/Unequip и legacy ChangeWeapon дают одинаковую публичную модель после replay', () => {
  const state = normalizeCampaignState({
    sessionCode: 'EQUIPMENT-VISUALS',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      characterClass: 'fighter',
      hp: 20,
      maxHp: 20,
      inventory: [
        { id: 'sword', catalog_id: 'srd_5_2_1:longsword', type: 'weapon', name: 'Длинный меч', equipped: true },
        { id: 'dagger', catalog_id: 'srd_5_2_1:dagger', type: 'weapon', name: 'Кинжал', equipped: false },
        { id: 'plate', catalog_id: 'srd_5_2_1:plate-armor', type: 'armor', name: 'Латы', equipped: false },
      ],
    }],
  })
  const equipped = applyGameEvent(state, {
    event_id: 'equip-plate',
    command_id: 'equip-plate',
    event_type: 'ItemEquipped',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { item_id: 'plate', equip_slot: 'body' },
  })
  const equippedAppearance = equipped.players[0].inventory
  assert.deepEqual(publicLoadoutForItems(equippedAppearance), {
    body: { model_key: 'armor-plate' },
    main_hand: { model_key: 'longsword' },
  })

  const unequipped = applyGameEvent(equipped, {
    event_id: 'unequip-plate',
    command_id: 'unequip-plate',
    event_type: 'ItemUnequipped',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { item_id: 'plate', equip_slot: 'body' },
  })
  assert.deepEqual(publicLoadoutForItems(unequipped.players[0].inventory), { main_hand: { model_key: 'longsword' } })

  const changed = applyGameEvent(unequipped, {
    event_id: 'change-dagger',
    command_id: 'change-dagger',
    event_type: 'EquipmentChanged',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { item_id: 'dagger', item_name: 'Кинжал', equipped: true, timing: 'action' },
  })
  const changeEvent = {
    event_id: 'change-dagger',
    command_id: 'change-dagger',
    event_type: 'EquipmentChanged',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { item_id: 'dagger', item_name: 'Кинжал', equipped: true, timing: 'action' },
  }
  const replayed = replayEvents(unequipped, [changeEvent])
  assert.deepEqual(publicLoadoutForItems(changed.players[0].inventory), { main_hand: { model_key: 'dagger' } })
  assert.deepEqual(changed.players, replayed.players)
})

test('старый attack_visual v1 остаётся прежним рядом с новым v2', () => {
  assert.deepEqual(normalizeAttackVisual({ version: 1, equipment: 'bow', private: 'drop' }), { version: 1, equipment: 'bow' })
  assert.deepEqual(normalizeAttackVisual({
    version: 2,
    equipment: 'sword-shield',
    loadout: { main_hand: { model_key: 'longsword' }, off_hand: { model_key: 'shield' } },
  }), {
    version: 2,
    equipment: 'sword-shield',
    loadout: { main_hand: { model_key: 'longsword' }, off_hand: { model_key: 'shield' } },
  })
})
