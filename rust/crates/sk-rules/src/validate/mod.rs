//! Проверка команды — `validateCommand` (`rules-engine.mjs`, 6132–7856).
//! Задача Р0: порядок блоков и общий проход.
//!
//! В JS это не `switch`, а 80 последовательных операторов, и **порядок
//! обязателен**: от него зависит код отказа игроку. Здесь они — таблица
//! [`BLOCKS`] в порядке JS: 68 проверочных блоков (объявления-помощники JS
//! сложены в блок, который их читает), преамбула (нормализация состояния и
//! команды) и `return command`. Блок дополняет команду на месте (`Object.assign`,
//! социальная проверка, удаление полей) — следующий блок видит уже
//! дополненную.
//!
//! Тела блоков — в файлах семейств; владельцы: `common` — Р0, `social_check` —
//! Р5, `campaign`, `scenario`, `scene`, `trade` — Р6, `society` — Р7,
//! `attack` — Р8, `spell` — Р9, `combat_action`, `movement` — Р10, `items`,
//! `combat_lifecycle`, `objects` — Р11, `actor_turn` — Р3, `vitals` — Р2.

mod actor_turn;
mod attack;
mod campaign;
mod combat_action;
mod combat_lifecycle;
pub mod common;
mod items;
mod movement;
mod objects;
mod scenario;
mod scene;
mod social_check;
mod society;
mod spell;
mod trade;
mod vitals;

use serde_json::Value;

use crate::command::normalize::normalize_command;
use crate::context::{Context, Uuid};
use crate::normalize::normalize_campaign_state_cow;
use crate::pause::{Halt, Step};

/// Состояние прохода по блокам.
pub struct Validation<'a> {
    /// Нормализованное состояние кампании.
    pub state: &'a Value,
    /// Команда: после `normalizeCommand`, дополняется блоками.
    pub command: Value,
    pub context: &'a Context,
    /// `actorFate` (6981): судьба действующего героя — её читают блоки 56 и 57.
    pub actor_fate: Option<Value>,
}

/// Блок `validateCommand`.
pub struct Block {
    /// Индекс оператора в теле `validateCommand` (0 — первый).
    pub index: usize,
    /// Строки JS.
    pub lines: &'static str,
    pub name: &'static str,
    pub check: fn(&mut Validation<'_>) -> Step,
}

/// Блоки в порядке JS.
pub const BLOCKS: &[Block] = &[
    Block { index: 2, lines: "6135–6137", name: "check_command_allowed", check: common::check_command_allowed },
    Block { index: 3, lines: "6138–6140", name: "check_state_version", check: common::check_state_version },
    Block { index: 7, lines: "6141–6151", name: "check_pending_reaction", check: common::check_pending_reaction },
    Block { index: 8, lines: "6152–6183", name: "check_social_check", check: social_check::check_social_check },
    Block { index: 9, lines: "6184–6193", name: "check_world_memory", check: campaign::check_world_memory },
    Block { index: 10, lines: "6194–6203", name: "check_npc_social", check: campaign::check_npc_social },
    Block { index: 11, lines: "6204–6213", name: "check_npc_world", check: society::check_npc_world },
    Block { index: 12, lines: "6214–6243", name: "check_captive", check: society::check_captive },
    Block { index: 13, lines: "6244–6251", name: "check_loot_container", check: society::check_loot_container },
    Block { index: 14, lines: "6252–6260", name: "check_beast", check: society::check_beast },
    Block { index: 15, lines: "6261–6287", name: "check_parley", check: society::check_parley },
    Block { index: 16, lines: "6288–6352", name: "check_law", check: society::check_law },
    Block { index: 17, lines: "6353–6465", name: "check_tavern", check: society::check_tavern },
    Block { index: 18, lines: "6466–6479", name: "check_scenario_purse", check: scenario::check_scenario_purse },
    Block { index: 19, lines: "6480–6502", name: "check_scenario_informant", check: scenario::check_scenario_informant },
    Block { index: 20, lines: "6503–6526", name: "check_dialogue", check: scenario::check_dialogue },
    Block { index: 21, lines: "6527–6549", name: "check_scenario_armory", check: scenario::check_scenario_armory },
    Block { index: 22, lines: "6550–6579", name: "check_scenario_treaty", check: scenario::check_scenario_treaty },
    Block { index: 23, lines: "6580–6619", name: "check_scenario_knight", check: scenario::check_scenario_knight },
    Block { index: 24, lines: "6620–6640", name: "check_scenario_stranger", check: scenario::check_scenario_stranger },
    Block { index: 25, lines: "6641–6679", name: "check_blessing", check: society::check_blessing },
    Block { index: 26, lines: "6683", name: "check_courier_letter", check: society::check_courier_letter },
    Block { index: 27, lines: "6684–6693", name: "check_character_build", check: campaign::check_character_build },
    Block { index: 28, lines: "6703–6705", name: "check_legendary_action", check: attack::check_legendary_action },
    Block { index: 29, lines: "6706–6710", name: "check_monster_action", check: attack::check_monster_action },
    Block { index: 30, lines: "6711–6713", name: "check_monster_spell", check: spell::check_monster_spell },
    Block { index: 32, lines: "6714–6763", name: "check_item_use", check: items::check_item_use },
    Block { index: 33, lines: "6764–6776", name: "check_character_lifecycle", check: campaign::check_character_lifecycle },
    Block { index: 37, lines: "6777–6802", name: "check_character_setup", check: common::check_character_setup },
    Block { index: 39, lines: "6803–6806", name: "check_campaign_paused", check: common::check_campaign_paused },
    Block { index: 40, lines: "6807–6809", name: "check_campaign_read_only", check: common::check_campaign_read_only },
    Block { index: 41, lines: "6810–6813", name: "check_quest_decision", check: campaign::check_quest_decision },
    Block { index: 42, lines: "6814–6825", name: "check_complete_campaign", check: campaign::check_complete_campaign },
    Block { index: 43, lines: "6826–6842", name: "check_advance_campaign_arc", check: campaign::check_advance_campaign_arc },
    Block { index: 44, lines: "6843–6862", name: "check_import_location_map", check: scene::check_import_location_map },
    Block { index: 45, lines: "6863–6878", name: "check_rebuild_location_map", check: scene::check_rebuild_location_map },
    Block { index: 46, lines: "6879–6899", name: "check_advance_scene", check: scene::check_advance_scene },
    Block { index: 47, lines: "6900–6902", name: "check_attack_npc", check: combat_lifecycle::check_attack_npc },
    Block { index: 48, lines: "6903–6921", name: "check_encounter_lifecycle", check: combat_lifecycle::check_encounter_lifecycle },
    Block { index: 49, lines: "6922–6954", name: "check_merchant_lifecycle", check: trade::check_merchant_lifecycle },
    Block { index: 50, lines: "6955–6957", name: "check_actor_exists", check: actor_turn::check_actor_exists },
    Block { index: 51, lines: "6958–6972", name: "check_targets_exist", check: actor_turn::check_targets_exist },
    Block { index: 52, lines: "6973", name: "check_actor_permission", check: actor_turn::check_actor_permission },
    Block { index: 53, lines: "6974", name: "check_turn", check: actor_turn::check_turn },
    Block { index: 54, lines: "6976–6979", name: "check_barricade_actor", check: objects::check_barricade_actor },
    Block { index: 56, lines: "6981–6984", name: "check_dead_hero", check: common::check_dead_hero },
    Block { index: 57, lines: "6985–6992", name: "check_resolve_hero_death", check: vitals::check_resolve_hero_death },
    Block { index: 58, lines: "6994–7042", name: "check_rest", check: vitals::check_rest },
    Block { index: 59, lines: "7044–7046", name: "check_start_combat", check: combat_lifecycle::check_start_combat },
    Block { index: 60, lines: "7047–7057", name: "check_end_combat", check: combat_lifecycle::check_end_combat },
    Block { index: 61, lines: "7058–7060", name: "check_healing_dead_hero", check: vitals::check_healing_dead_hero },
    Block { index: 62, lines: "7061–7063", name: "check_reduce_hit_point_maximum", check: vitals::check_reduce_hit_point_maximum },
    Block { index: 63, lines: "7064–7156", name: "check_trade", check: trade::check_trade },
    Block { index: 64, lines: "7171–7200", name: "check_pickpocket", check: trade::check_pickpocket },
    Block { index: 65, lines: "7201–7221", name: "check_grant_item", check: items::check_grant_item },
    Block { index: 66, lines: "7222–7301", name: "check_make_attack", check: attack::check_make_attack },
    Block { index: 67, lines: "7302–7316", name: "check_change_weapon", check: attack::check_change_weapon },
    Block { index: 68, lines: "7317–7324", name: "check_make_area_attack", check: attack::check_make_area_attack },
    Block { index: 69, lines: "7325–7568", name: "check_cast_spell", check: spell::check_cast_spell },
    Block { index: 70, lines: "7569–7585", name: "check_identify_enemy", check: vitals::check_identify_enemy },
    Block { index: 71, lines: "7586–7768", name: "check_combat_action", check: combat_action::check_combat_action },
    Block { index: 72, lines: "7769–7791", name: "check_move_actor", check: movement::check_move_actor },
    Block { index: 73, lines: "7796–7801", name: "check_move_speed", check: movement::check_move_speed },
    Block { index: 74, lines: "7819–7821", name: "check_provenance", check: common::check_provenance },
    Block { index: 75, lines: "7822–7825", name: "check_amount", check: common::check_amount },
    Block { index: 76, lines: "7826–7829", name: "check_resource", check: common::check_resource },
    Block { index: 77, lines: "7830–7832", name: "check_condition_required", check: common::check_condition_required },
    Block { index: 78, lines: "7833–7854", name: "check_scene_object", check: objects::check_scene_object },
];

/// `validateCommand(input, rawState, context)`.
pub fn validate_command(input: &Value, raw_state: &Value, context: &Context, uuid: Uuid<'_>) -> Result<Value, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    validate_normalized(input, &state, context, uuid)
}

/// `validateCommand` над уже нормализованным состоянием (операторы 1–79).
pub fn validate_normalized(input: &Value, state: &Value, context: &Context, uuid: Uuid<'_>) -> Result<Value, Halt> {
    validate_blocks(input, state, context, uuid, BLOCKS.len())
}

/// Первые `count` блоков — для сверки по частям, пока не все блоки перенесены.
pub fn validate_blocks(input: &Value, state: &Value, context: &Context, uuid: Uuid<'_>, count: usize) -> Result<Value, Halt> {
    let command = normalize_command(input, state, uuid)?;
    let mut validation = Validation { state, command, context, actor_fate: None };
    for block in BLOCKS.iter().take(count) {
        (block.check)(&mut validation)?;
    }
    Ok(validation.command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_follow_js_order() {
        let indices: Vec<usize> = BLOCKS.iter().map(|block| block.index).collect();
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        assert_eq!(indices, sorted, "блоки идут в порядке операторов JS");
        assert_eq!(BLOCKS.len(), 68);
        assert_eq!(BLOCKS.first().map(|block| block.index), Some(2));
        assert_eq!(BLOCKS.last().map(|block| block.index), Some(78));
    }
}
