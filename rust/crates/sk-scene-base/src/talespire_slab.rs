//! Перенос `server/talespire-slab.mjs`: разбор слэба TaleSpire — строки,
//! которую игра кладёт в буфер обмена при копировании выделенной области.
//!
//! Формат v2 описан разработчиком игры
//! (<https://github.com/Bouncyrock/DumbSlabStats/blob/master/format.md>);
//! формат v1 восстановлен по образцам: те же 20-байтовые описания видов, но
//! экземпляр занимает 28 байт — центр и полуразмеры габарита в мировых
//! координатах (шесть float32) и байт поворота.
//!
//! Модуль ничего не знает о каталоге ассетов и о тактической карте: он только
//! превращает строку в список экземпляров. Любая ошибка разбора —
//! [`TaleSpireSlabError`] с кодом и русским текстом.

use std::fmt;
use std::io::Read;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};

use crate::util::utf16_len;

pub const SLAB_MAGIC: u32 = 0xD1CE_FACE;
/// Предел сжатого слэба, который принимает сама игра (format.md).
pub const SLAB_MAX_PACKED_BYTES: usize = 30720;
/// Предел распакованных данных.
pub const SLAB_MAX_UNPACKED_BYTES: usize = 4 * 1024 * 1024;
/// Предел текста: base64 от 30 КБ плюс обрамление кавычками и пробелы.
pub const SLAB_MAX_TEXT_LENGTH: usize = 48 * 1024;

/// Пределы видов и экземпляров (аудит PR #131, MAP-BOUNDARY-01): число
/// проверяется по заголовкам видов — до того, как собран хоть один экземпляр.
pub const SLAB_MAX_LAYOUTS: usize = 4096;
pub const SLAB_MAX_INSTANCES: usize = 50_000;

/// Числовые границы v1 (аудит PR #131, MAP-BOUNDARY-02): конечное — ещё не
/// ограниченное.
pub const SLAB_MAX_COORDINATE: f64 = 1_000_000.0;
pub const SLAB_MAX_HALF_EXTENT: f64 = 32.0;

const V1_INSTANCE_BYTES: usize = 28;
const V2_INSTANCE_BYTES: usize = 8;
const LAYOUT_BYTES: usize = 20;
const MASK_18: u64 = (1 << 18) - 1;

/// Ошибка разбора слэба: код для маршрута и текст для игрока.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaleSpireSlabError {
    pub code: String,
    pub message: String,
}

impl TaleSpireSlabError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for TaleSpireSlabError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaleSpireSlabError {}

/// Точка в мировых координатах слэба.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SlabVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Экземпляр ассета в слэбе.
#[derive(Debug, Clone, PartialEq)]
pub enum SlabInstance {
    /// v2: точка — минимальный угол повёрнутого габарита в клетках (сотые),
    /// поворот — шаги по 15°.
    V2 { asset_id: String, x: f64, y: f64, z: f64, rotation: f64 },
    /// v1: габарит уже повёрнут и лежит в мировых координатах; поворот — шаг 22,5°.
    V1 { asset_id: String, center: SlabVector, extent: SlabVector, rotation: f64 },
}

impl SlabInstance {
    pub fn asset_id(&self) -> &str {
        match self {
            Self::V2 { asset_id, .. } | Self::V1 { asset_id, .. } => asset_id,
        }
    }

    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        let vector = |point: &SlabVector| json!({ "x": js::num(point.x), "y": js::num(point.y), "z": js::num(point.z) });
        match self {
            Self::V2 { asset_id, x, y, z, rotation } => {
                json!({ "assetId": asset_id, "x": js::num(*x), "y": js::num(*y), "z": js::num(*z), "rotation": js::num(*rotation) })
            }
            Self::V1 { asset_id, center, extent, rotation } => {
                json!({ "assetId": asset_id, "center": vector(center), "extent": vector(extent), "rotation": js::num(*rotation) })
            }
        }
    }
}

/// Разобранный слэб.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSlab {
    /// 1 или 2.
    pub version: u16,
    pub packed_bytes: usize,
    /// Число видов ассетов.
    pub kinds: usize,
    pub instances: Vec<SlabInstance>,
}

impl DecodedSlab {
    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        let mut result = Map::new();
        result.insert("version".into(), Value::from(self.version));
        result.insert("packedBytes".into(), Value::from(self.packed_bytes));
        result.insert("kinds".into(), Value::from(self.kinds));
        result.insert("instances".into(), Value::Array(self.instances.iter().map(SlabInstance::to_value).collect()));
        Value::Object(result)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// GUID в порядке байт .NET: первые три поля little-endian, остальное как есть.
/// Недостающие байты первых полей — нули, как у `Buffer.from([undefined])`.
pub fn guid_from_bytes(bytes: &[u8]) -> String {
    let at = |index: usize| bytes.get(index).copied().unwrap_or(0);
    let range = |from: usize, to: usize| &bytes[from.min(bytes.len())..to.min(bytes.len())];
    [hex(&[at(3), at(2), at(1), at(0)]), hex(&[at(5), at(4)]), hex(&[at(7), at(6)]), hex(range(8, 10)), hex(range(10, 16))].join("-")
}

/// Снимает обрамление из тройных обратных кавычек и пробелы, в том числе
/// переносы строк внутри base64.
pub fn normalize_slab_text(value: &str) -> String {
    let mut value = text::trim(value);
    if let Some(rest) = value.strip_prefix("```") {
        value = rest;
    }
    if let Some(rest) = value.strip_suffix("```") {
        value = rest;
    }
    text::replace_all(re!(r"\s+", "gu"), value, "")
}

/// `Buffer.from(text, 'base64')` для строки из алфавита base64 с `=` в конце:
/// неполная четвёрка даёт столько байт, сколько в ней целых, лишние биты
/// отбрасываются.
fn decode_base64(body: &str) -> Vec<u8> {
    let digit = |byte: u8| -> u32 {
        match byte {
            b'A'..=b'Z' => u32::from(byte - b'A'),
            b'a'..=b'z' => u32::from(byte - b'a') + 26,
            b'0'..=b'9' => u32::from(byte - b'0') + 52,
            b'+' => 62,
            _ => 63,
        }
    };
    let digits: Vec<u32> = body.bytes().filter(|byte| *byte != b'=').map(digit).collect();
    let mut bytes = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let mut buffer = 0u32;
        for (index, value) in chunk.iter().enumerate() {
            buffer |= value << (18 - 6 * index);
        }
        let produced = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => 0,
        };
        for index in 0..produced {
            bytes.push((buffer >> (16 - 8 * index)) as u8);
        }
    }
    bytes
}

/// `gunzipSync(packed, { maxOutputLength })` по правилам Node: члены gzip
/// идут подряд, нулевые байты после члена — набивка, больше предела — ошибка.
fn gunzip(packed: &[u8]) -> Option<Vec<u8>> {
    if packed.is_empty() {
        return None;
    }
    let mut output = Vec::new();
    let mut rest = packed;
    loop {
        let mut decoder = flate2::bufread::GzDecoder::new(rest);
        let room = (SLAB_MAX_UNPACKED_BYTES - output.len()) as u64 + 1;
        let mut member = Vec::new();
        (&mut decoder).take(room).read_to_end(&mut member).ok()?;
        output.extend_from_slice(&member);
        if output.len() > SLAB_MAX_UNPACKED_BYTES {
            return None;
        }
        // Член должен закончиться целиком: обрезанный поток — ошибка.
        let mut probe = [0u8; 1];
        if decoder.read(&mut probe).ok()? != 0 {
            return None;
        }
        rest = decoder.into_inner();
        if rest.is_empty() || rest[0] == 0 {
            return Some(output);
        }
    }
}

fn truncated() -> TaleSpireSlabError {
    TaleSpireSlabError::new("Слэб обрезан: данных меньше, чем объявлено в заголовке", "SLAB_TRUNCATED")
}

fn require_bytes(data: &[u8], offset: usize, need: usize) -> Result<(), TaleSpireSlabError> {
    if offset + need > data.len() {
        return Err(truncated());
    }
    Ok(())
}

fn u16_at(data: &[u8], offset: usize) -> Result<u16, TaleSpireSlabError> {
    data.get(offset..offset + 2).map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]])).ok_or_else(truncated)
}

fn f32_at(data: &[u8], offset: usize) -> f64 {
    f64::from(f32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]))
}

/// Разбор строки из буфера обмена TaleSpire. `None` — не строка (в JS —
/// значение другого типа).
pub fn decode_slab(input: Option<&str>) -> Result<DecodedSlab, TaleSpireSlabError> {
    let Some(raw) = input.filter(|raw| !text::trim(raw).is_empty()) else {
        return Err(TaleSpireSlabError::new("Вставьте строку слэба", "SLAB_EMPTY"));
    };
    if utf16_len(raw) > SLAB_MAX_TEXT_LENGTH {
        return Err(TaleSpireSlabError::new("Слэб длиннее, чем допускает TaleSpire", "SLAB_TOO_LARGE"));
    }
    let body = normalize_slab_text(raw);
    if !text::test(re!(r"^[A-Za-z0-9+/]+={0,2}$", "u"), &body) {
        return Err(TaleSpireSlabError::new("Это не слэб TaleSpire: строка не в base64", "SLAB_NOT_BASE64"));
    }
    let packed = decode_base64(&body);
    if packed.len() > SLAB_MAX_PACKED_BYTES {
        return Err(TaleSpireSlabError::new("Слэб длиннее, чем допускает TaleSpire", "SLAB_TOO_LARGE"));
    }
    let Some(data) = gunzip(&packed) else {
        return Err(TaleSpireSlabError::new("Это не слэб TaleSpire: данные не распаковываются", "SLAB_NOT_GZIP"));
    };
    require_bytes(&data, 0, 8)?;
    if u32::from_le_bytes([data[0], data[1], data[2], data[3]]) != SLAB_MAGIC {
        return Err(TaleSpireSlabError::new("Это не слэб TaleSpire: неверная сигнатура", "SLAB_BAD_MAGIC"));
    }
    let version = u16_at(&data, 4)?;
    if version != 1 && version != 2 {
        return Err(TaleSpireSlabError::new(format!("Версия слэба {version} не поддерживается"), "SLAB_VERSION_UNSUPPORTED"));
    }
    let layout_count = usize::from(u16_at(&data, 6)?);
    if layout_count > SLAB_MAX_LAYOUTS {
        return Err(TaleSpireSlabError::new(
            format!("В слэбе {layout_count} видов ассетов — больше предела {SLAB_MAX_LAYOUTS}"),
            "SLAB_TOO_MANY_LAYOUTS",
        ));
    }
    let mut offset = 8;
    if version == 2 {
        require_bytes(&data, offset, 2)?;
        offset += 2; // число существ, в v2 всегда ноль
    }
    let mut layouts: Vec<(String, usize)> = Vec::with_capacity(layout_count);
    require_bytes(&data, offset, layout_count * LAYOUT_BYTES)?;
    for _ in 0..layout_count {
        layouts.push((guid_from_bytes(&data[offset..offset + 16]), usize::from(u16_at(&data, offset + 16)?)));
        offset += LAYOUT_BYTES;
    }
    let declared: usize = layouts.iter().map(|(_, count)| count).sum();
    if declared > SLAB_MAX_INSTANCES {
        return Err(TaleSpireSlabError::new(
            format!("В слэбе {declared} объектов — больше предела {SLAB_MAX_INSTANCES}: скопируйте часть доски"),
            "SLAB_TOO_MANY_INSTANCES",
        ));
    }
    let mut instances: Vec<SlabInstance> = Vec::with_capacity(declared);
    for (asset_id, count) in &layouts {
        if version == 2 {
            require_bytes(&data, offset, count * V2_INSTANCE_BYTES)?;
            for _ in 0..*count {
                let mut word = [0u8; 8];
                word.copy_from_slice(&data[offset..offset + 8]);
                let packed_value = u64::from_le_bytes(word);
                offset += V2_INSTANCE_BYTES;
                instances.push(SlabInstance::V2 {
                    asset_id: asset_id.clone(),
                    x: (packed_value & MASK_18) as f64 / 100.0,
                    y: ((packed_value >> 18) & MASK_18) as f64 / 100.0,
                    z: ((packed_value >> 36) & MASK_18) as f64 / 100.0,
                    rotation: ((packed_value >> 54) & 31) as f64 * 15.0,
                });
            }
        } else {
            require_bytes(&data, offset, count * V1_INSTANCE_BYTES)?;
            for _ in 0..*count {
                let at = |slot: usize| f32_at(&data, offset + slot * 4);
                let center = SlabVector { x: at(0), y: at(1), z: at(2) };
                let extent = SlabVector { x: at(3).abs(), y: at(4).abs(), z: at(5).abs() };
                // байт поворота: 0, 4, 8, 12 — четверти оборота, то есть шаг 22,5°
                let rotation = f64::from(data[offset + 24] % 16) * 22.5;
                offset += V1_INSTANCE_BYTES;
                let values = [center.x, center.y, center.z, extent.x, extent.y, extent.z];
                if !values.iter().all(|value| value.is_finite()) {
                    return Err(TaleSpireSlabError::new("Слэб повреждён: координаты не числа", "SLAB_CORRUPT"));
                }
                if ![center.x, center.y, center.z].iter().all(|value| value.abs() <= SLAB_MAX_COORDINATE) {
                    return Err(TaleSpireSlabError::new(
                        format!("Слэб повреждён: объект дальше {} клеток от начала доски", js::f64_string(SLAB_MAX_COORDINATE)),
                        "SLAB_COORDINATE_OUT_OF_RANGE",
                    ));
                }
                if ![extent.x, extent.y, extent.z].iter().all(|value| *value <= SLAB_MAX_HALF_EXTENT) {
                    return Err(TaleSpireSlabError::new(
                        format!("Слэб повреждён: объект больше {} клеток в поперечнике", js::f64_string(2.0 * SLAB_MAX_HALF_EXTENT)),
                        "SLAB_EXTENT_TOO_LARGE",
                    ));
                }
                instances.push(SlabInstance::V1 { asset_id: asset_id.clone(), center, extent, rotation });
            }
        }
    }
    Ok(DecodedSlab { version, packed_bytes: packed.len(), kinds: layouts.len(), instances })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_follows_node() {
        assert_eq!(decode_base64("QQ"), b"A");
        assert_eq!(decode_base64("Q"), b"");
        assert_eq!(decode_base64("QUJD="), b"ABC");
        assert_eq!(decode_base64("QUJDRA"), b"ABCD");
        assert_eq!(decode_base64("QR=="), b"A");
    }

    #[test]
    fn guid_uses_dotnet_byte_order() {
        let bytes: Vec<u8> = (0u8..16).collect();
        assert_eq!(guid_from_bytes(&bytes), "03020100-0504-0706-0809-0a0b0c0d0e0f");
        assert_eq!(guid_from_bytes(&bytes[..9]), "03020100-0504-0706-08-");
    }
}
