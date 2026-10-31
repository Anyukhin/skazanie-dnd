//! Математика JS, от которой зависит клетка или выбор предмета, — общая
//! `sk_core::v8math`. Здесь — её имена в крейте и побитная сверка с Node на
//! эталонах расстановки и обстановки.

pub(crate) use sk_core::v8math::{atan2 as js_atan2, pow as js_pow, sin as js_sin};

#[cfg(test)]
mod fixture_tests {
    use super::js_pow;
    use serde_json::Value;

    /// Веса добора `1 / (1 + count) ** 1.6`: побитно как у Node (эталон
    /// `fixtures/prop-placement.json`, разделы `pow` и `powTail`).
    #[test]
    fn pow_matches_node_bit_for_bit() {
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/prop-placement.json")).expect("эталон");
        let bits = |value: f64| format!("{:x}", value.to_bits());
        let mut checked = 0;
        for row in fixture["pow"].as_array().expect("pow") {
            let n = row[0].as_f64().expect("основание");
            let power = js_pow(n, 1.6);
            assert_eq!(bits(power), row[1].as_str().unwrap_or_default(), "{n} ** 1.6");
            assert_eq!(bits(1.0 / power), row[2].as_str().unwrap_or_default(), "1 / {n} ** 1.6");
            checked += 1;
        }
        assert_eq!(checked, 2000);
        // Хвост 2001…20000: Node берёт `pow` платформы (UCRT), и тот на девяти
        // основаниях ошибается чуть больше чем на полбита (0.5005…0.5025 ulp,
        // проверено десятичной арифметикой на 80 знаков). Rust здесь верно
        // округляет; в расстановке такие основания недостижимы — столько
        // экземпляров одного вида в зоне не бывает.
        const UCRT_MISROUNDED: [u64; 9] = [2725, 3476, 8400, 12145, 12161, 12311, 12563, 14632, 14779];
        let tail = &fixture["powTail"];
        let from = tail["from"].as_u64().expect("начало");
        let packed = tail["bits"].as_str().expect("биты хвоста");
        let mut misrounded = Vec::new();
        for (offset, chunk) in packed.as_bytes().chunks(16).enumerate() {
            let n = from + offset as u64;
            let expected = u64::from_str_radix(std::str::from_utf8(chunk).expect("hex"), 16).expect("hex");
            let actual = js_pow(n as f64, 1.6).to_bits();
            if actual != expected {
                assert_eq!(actual.abs_diff(expected), 1, "{n} ** 1.6 расходится больше чем на ulp");
                misrounded.push(n);
            }
        }
        assert_eq!(misrounded, UCRT_MISROUNDED);
    }
}

#[cfg(test)]
mod trig_fixture_tests {
    use super::{js_atan2, js_sin};
    use serde_json::Value;

    fn value(text: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(text.as_str().unwrap_or_default(), 16).expect("биты"))
    }

    /// Неровный край пятна: `Math.atan2` и `Math.sin(Math.atan2(dy, dx) * 3 + x)`
    /// на всей области `roughenGround` и на случайных аргументах — побитно как
    /// у V8 (эталон `fixtures/scene-dressing.json`).
    #[test]
    fn trig_matches_v8_bit_for_bit() {
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/scene-dressing.json")).expect("эталон");
        for row in fixture["atan2"].as_array().expect("atan2") {
            let (dx, dy) = (row[0].as_f64().expect("dx"), row[1].as_f64().expect("dy"));
            assert_eq!(js_atan2(dy, dx).to_bits(), value(&row[2]).to_bits(), "atan2({dy}, {dx})");
        }
        let packed = fixture["sin"]["bits"].as_str().expect("биты");
        let mut chunks = packed.as_bytes().chunks(16);
        for dy in -3_i64..=3 {
            for dx in -3_i64..=3 {
                for x in 0..=120 {
                    let expected = u64::from_str_radix(std::str::from_utf8(chunks.next().expect("значение")).expect("hex"), 16).expect("hex");
                    let actual = js_sin(js_atan2(dy as f64, dx as f64) * 3.0 + x as f64);
                    assert_eq!(actual.to_bits(), expected, "sin(atan2({dy}, {dx}) * 3 + {x})");
                }
            }
        }
        assert!(chunks.next().is_none());
        for row in fixture["sinRandom"].as_array().expect("sinRandom") {
            let x = value(&row[0]);
            assert_eq!(js_sin(x).to_bits(), value(&row[1]).to_bits(), "sin({x})");
        }
        for row in fixture["atan2Random"].as_array().expect("atan2Random") {
            let (y, x) = (value(&row[0]), value(&row[1]));
            assert_eq!(js_atan2(y, x).to_bits(), value(&row[2]).to_bits(), "atan2({y}, {x})");
        }
    }
}
