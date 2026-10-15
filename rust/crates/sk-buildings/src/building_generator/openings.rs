//! Проёмы прямоугольного корпуса: двери между комнатами, парадная и задняя
//! двери, окна наружных стен.

use sk_tactical::tactical_map::{self as tm, TacticalMap};

use super::{open_doorway, open_window, Rect, Result, RoomPlan, DIRS};

fn find<'r>(rooms: &'r [RoomPlan], zone_id: &str) -> Option<&'r RoomPlan> {
    rooms.iter().find(|room| room.zone_id == zone_id)
}

/// `connectDesignRooms(map, rooms, firstId, secondId, doorId)`: дверь в
/// середине общей одноклеточной стены двух комнат плана.
pub(crate) fn connect_design_rooms(map: &mut TacticalMap, rooms: &[RoomPlan], first_id: &str, second_id: &str, door_id: &str) -> Result<bool> {
    let (Some(first), Some(second)) = (find(rooms, first_id), find(rooms, second_id)) else { return Ok(false) };
    let overlap_y = first.max_y.min(second.max_y) - first.min_y.max(second.min_y);
    if first.max_x + 2 == second.min_x || second.max_x + 2 == first.min_x {
        let wall_x = if first.max_x + 2 == second.min_x { first.max_x + 1 } else { second.max_x + 1 };
        let y = (first.min_y.max(second.min_y) + first.max_y.min(second.max_y)).div_euclid(2);
        if overlap_y >= 0 {
            open_doorway(map, wall_x, y, door_id)?;
            return Ok(true);
        }
        return Ok(false);
    }
    let overlap_x = first.max_x.min(second.max_x) - first.min_x.max(second.min_x);
    if first.max_y + 2 == second.min_y || second.max_y + 2 == first.min_y {
        let wall_y = if first.max_y + 2 == second.min_y { first.max_y + 1 } else { second.max_y + 1 };
        let x = (first.min_x.max(second.min_x) + first.max_x.min(second.max_x)).div_euclid(2);
        if overlap_x >= 0 {
            open_doorway(map, x, wall_y, door_id)?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// `openDesignExteriorDoor(map, rooms, building, id)`: парадная дверь зала,
/// южная стена первой. Возвращает x начала тропы.
pub(crate) fn open_design_exterior_door(map: &mut TacticalMap, rooms: &[RoomPlan], building: Rect, id: &str) -> Result<i64> {
    let Some(room) = find(rooms, "hall").or(rooms.first()) else { return Ok((building.min_x + building.max_x).div_euclid(2)) };
    if room.max_y == building.max_y - 1 {
        let x = (room.min_x + room.max_x).div_euclid(2);
        open_doorway(map, x, building.max_y, id)?;
        return Ok(x);
    }
    if room.min_y == building.min_y + 1 {
        let x = (room.min_x + room.max_x).div_euclid(2);
        open_doorway(map, x, building.min_y, id)?;
        return Ok(x);
    }
    if room.min_x == building.min_x + 1 {
        open_doorway(map, building.min_x, (room.min_y + room.max_y).div_euclid(2), id)?;
        return Ok(1.max(building.min_x - 1));
    }
    open_doorway(map, building.max_x, (room.min_y + room.max_y).div_euclid(2), id)?;
    Ok((map.width - 2).min(building.max_x + 1))
}

/// Наружная стена комнаты: сторона и клетки кладки вдоль комнаты.
pub(crate) struct OuterWall {
    pub side: char,
    pub cells: Vec<(i64, i64)>,
}

/// `outerWallsOf(room, building)`: стены комнаты на наружном контуре.
pub(crate) fn outer_walls_of(room: &RoomPlan, building: Rect) -> Vec<OuterWall> {
    let mut sides = Vec::new();
    if room.max_y == building.max_y - 1 {
        sides.push(OuterWall { side: 's', cells: (room.min_x..=room.max_x).map(|x| (x, building.max_y)).collect() });
    }
    if room.min_y == building.min_y + 1 {
        sides.push(OuterWall { side: 'n', cells: (room.min_x..=room.max_x).map(|x| (x, building.min_y)).collect() });
    }
    if room.min_x == building.min_x + 1 {
        sides.push(OuterWall { side: 'w', cells: (room.min_y..=room.max_y).map(|y| (building.min_x, y)).collect() });
    }
    if room.max_x == building.max_x - 1 {
        sides.push(OuterWall { side: 'e', cells: (room.min_y..=room.max_y).map(|y| (building.max_x, y)).collect() });
    }
    sides
}

/// `openDesignWindows(map, rooms, building)`: окна во всех жилых комнатах,
/// шаг три клетки от середины стены, не у двери и не в углу; кладовая — одно
/// окно, внутренний двор — ни одного.
pub(crate) fn open_design_windows(map: &mut TacticalMap, rooms: &[RoomPlan], building: Rect) -> Result<()> {
    for room in rooms {
        if room.zone_id == "courtyard" {
            continue;
        }
        let mut budget = match room.zone_id.as_str() {
            "hall" => 6,
            "store" => 1,
            _ => 3,
        };
        for wall in outer_walls_of(room, building) {
            let cells = &wall.cells;
            let length = cells.len() as i64;
            let middle = length.div_euclid(2);
            let inner: Vec<i64> = (1..length - 1).collect();
            let primary: Vec<i64> = inner.iter().copied().filter(|index| (index - middle).abs() % 3 == 0).collect();
            let mut secondary: Vec<i64> = inner.iter().copied().filter(|index| (index - middle).abs() % 3 != 0).collect();
            secondary.sort_by_key(|index| (index - middle).abs());
            let mut on_wall = 0;
            for (index, is_primary) in primary.iter().map(|index| (*index, true)).chain(secondary.iter().map(|index| (*index, false))) {
                if budget <= 0 {
                    break;
                }
                if on_wall > 0 && !is_primary {
                    break;
                }
                let (x, y) = cells[index as usize];
                let Some(own) = tm::cell_at(map, x, y) else { continue };
                if own.passable {
                    continue;
                }
                // Рядом с дверным проёмом — косяк, а не окно.
                let near_door = DIRS.iter().any(|(dx, dy)| {
                    let neighbor = tm::cell_at(map, x + dx, y + dy);
                    neighbor.is_some_and(|cell| cell.passable && cell.zone != room.zone_id && cell.zone != "yard")
                        || map.doors.iter().any(|door| door.x == x + dx && door.y == y + dy)
                });
                if near_door {
                    continue;
                }
                open_window(map, x, y)?;
                budget -= 1;
                on_wall += 1;
            }
        }
    }
    Ok(())
}

/// `openDesignBackDoor(map, rooms, building)`: задняя дверь кухни,
/// мастерской или кладовой во двор; сперва стены от пяти клеток, север и бока
/// раньше юга.
pub(crate) fn open_design_back_door(map: &mut TacticalMap, rooms: &[RoomPlan], building: Rect) -> Result<bool> {
    let candidates: Vec<&RoomPlan> = ["kitchen", "workshop", "store"].iter().filter_map(|id| find(rooms, id)).collect();
    for minimum in [5, 3] {
        for room in &candidates {
            let mut sides = outer_walls_of(room, building);
            sides.sort_by_key(|wall| "nwes".find(wall.side).unwrap_or(usize::MAX));
            for wall in sides {
                if wall.cells.len() < minimum {
                    continue;
                }
                let (x, y) = wall.cells[wall.cells.len() / 2];
                let (dx, dy) = match wall.side {
                    'n' => (0, -1),
                    's' => (0, 1),
                    'w' => (-1, 0),
                    _ => (1, 0),
                };
                let outside = tm::cell_at(map, x + dx, y + dy);
                if !outside.is_some_and(|cell| cell.passable && cell.zone == "yard") {
                    continue;
                }
                open_doorway(map, x, y, "back-door")?;
                return Ok(true);
            }
        }
    }
    Ok(false)
}
