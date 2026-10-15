//! `Math.sin` как в V8: перенос fdlibm (`s_sin.c`, `k_sin.c`, `k_cos.c`,
//! `e_rem_pio2.c`), которым V8 считает синус (`src/base/ieee754.cc`).
//!
//! Генератор поселения синусом гнёт улицу и русло реки, а `Math.round` и
//! сравнение `> 0.75` превращают последний бит в клетку. Системный `f64::sin`
//! (libm платформы) с V8 побитно не обязан совпадать, поэтому формулы
//! повторены дословно, константы — битовые образы из fdlibm. Сверка — эталон
//! `fixtures/math-sin.json`.
//!
//! Аргументы генератора ограничены (|x| < 50), поэтому перенесена редукция
//! только малых и средних аргументов (|x| ≤ 2¹⁹·π/2); для больших — системный
//! синус, генератор туда не попадает.

const HALF: f64 = 0.5;
const ONE: f64 = 1.0;

const S1: f64 = f64::from_bits(0xBFC5_5555_5555_5549);
const S2: f64 = f64::from_bits(0x3F81_1111_1110_F8A6);
const S3: f64 = f64::from_bits(0xBF2A_01A0_19C1_61D5);
const S4: f64 = f64::from_bits(0x3EC7_1DE3_57B1_FE7D);
const S5: f64 = f64::from_bits(0xBE5A_E5E6_8A2B_9CEB);
const S6: f64 = f64::from_bits(0x3DE5_D93A_5ACF_D57C);

const C1: f64 = f64::from_bits(0x3FA5_5555_5555_554C);
const C2: f64 = f64::from_bits(0xBF56_C16C_16C1_5177);
const C3: f64 = f64::from_bits(0x3EFA_01A0_19CB_1590);
const C4: f64 = f64::from_bits(0xBE92_7E4F_809C_52AD);
const C5: f64 = f64::from_bits(0x3E21_EE9E_BDB4_B1C4);
const C6: f64 = f64::from_bits(0xBDA8_FAE9_BE88_38D4);

const INVPIO2: f64 = f64::from_bits(0x3FE4_5F30_6DC9_C883);
const PIO2_1: f64 = f64::from_bits(0x3FF9_21FB_5440_0000);
const PIO2_1T: f64 = f64::from_bits(0x3DD0_B461_1A62_6331);
const PIO2_2: f64 = f64::from_bits(0x3DD0_B461_1A60_0000);
const PIO2_2T: f64 = f64::from_bits(0x3BA3_198A_2E03_7073);
const PIO2_3: f64 = f64::from_bits(0x3BA3_198A_2E00_0000);
const PIO2_3T: f64 = f64::from_bits(0x397B_839A_2520_49C1);

/// Старшие слова n·π/2 для n = 1…32: проверка на сокращение разрядов.
const NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
    0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];

fn high_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

/// `__kernel_sin(x, y, iy)`: синус на [−π/4, π/4], `y` — хвост аргумента.
fn kernel_sin(x: f64, y: f64, iy: bool) -> f64 {
    let ix = high_word(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if !iy {
        x + v * (S1 + z * r)
    } else {
        x - ((z * (HALF * y - v * r) - y) - v * S1)
    }
}

/// `__kernel_cos(x, y)`: косинус на [−π/4, π/4].
fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high_word(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return ONE;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3FD3_3333 {
        return ONE - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe9_0000 { 0.28125 } else { f64::from_bits(u64::from((ix - 0x0020_0000) as u32) << 32) };
    let iz = 0.5 * z - qx;
    let a = ONE - qx;
    a - (iz - (z * r - x * y))
}

/// `__ieee754_rem_pio2(x)` для |x| ≤ 2¹⁹·π/2: `(n, y0, y1)`, x = n·π/2 + y.
/// Больший аргумент — `None`.
fn rem_pio2(x: f64) -> Option<(i32, f64, f64)> {
    let hx = high_word(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return Some((0, x, 0.0));
    }
    if ix < 0x4002_d97c {
        // |x| < 3π/4: n = ±1.
        return Some(if hx > 0 {
            let z = x - PIO2_1;
            if ix != 0x3ff9_21fb {
                let y0 = z - PIO2_1T;
                (1, y0, (z - y0) - PIO2_1T)
            } else {
                let z = z - PIO2_2;
                let y0 = z - PIO2_2T;
                (1, y0, (z - y0) - PIO2_2T)
            }
        } else {
            let z = x + PIO2_1;
            if ix != 0x3ff9_21fb {
                let y0 = z + PIO2_1T;
                (-1, y0, (z - y0) + PIO2_1T)
            } else {
                let z = z + PIO2_2;
                let y0 = z + PIO2_2T;
                (-1, y0, (z - y0) + PIO2_2T)
            }
        });
    }
    if ix > 0x4139_21fb {
        return None;
    }
    let t = x.abs();
    let n = (t * INVPIO2 + HALF) as i32;
    let fn_ = f64::from(n);
    let mut r = t - fn_ * PIO2_1;
    let mut w = fn_ * PIO2_1T;
    let y0;
    if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
        y0 = r - w;
    } else {
        let j = ix >> 20;
        let mut first = r - w;
        let mut i = j - ((high_word(first) >> 20) & 0x7ff);
        if i > 16 {
            let t = r;
            w = fn_ * PIO2_2;
            r = t - w;
            w = fn_ * PIO2_2T - ((t - r) - w);
            first = r - w;
            i = j - ((high_word(first) >> 20) & 0x7ff);
            if i > 49 {
                let t = r;
                w = fn_ * PIO2_3;
                r = t - w;
                w = fn_ * PIO2_3T - ((t - r) - w);
                first = r - w;
            }
        }
        y0 = first;
    }
    let y1 = (r - y0) - w;
    Some(if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) })
}

/// `Math.sin(x)` как в V8.
pub(crate) fn sin(x: f64) -> f64 {
    let ix = high_word(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff0_0000 {
        return x - x;
    }
    let Some((n, y0, y1)) = rem_pio2(x) else {
        // Большие аргументы генератору не встречаются (см. шапку модуля).
        return x.sin();
    };
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

#[cfg(test)]
mod tests {
    use super::sin;

    fn bits(text: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(text, 16).expect("битовый образ"))
    }

    /// Сверка с `Math.sin` Node (`fixtures/gen-math-sin.mjs`).
    #[test]
    fn sin_matches_v8_bit_for_bit() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/math-sin.json")).expect("эталон");
        let cases = fixture["cases"].as_array().expect("случаи");
        assert!(cases.len() > 5_000);
        let mut failures = Vec::new();
        for case in cases {
            let x = bits(case[0].as_str().expect("x"));
            let expected = bits(case[1].as_str().expect("sin"));
            let actual = sin(x);
            if actual.to_bits() != expected.to_bits() {
                failures.push(format!("sin({x:e}) = {actual:e}, V8 {expected:e}"));
            }
        }
        assert!(failures.is_empty(), "{} расхождений из {}: {:?}", failures.len(), cases.len(), &failures[..failures.len().min(5)]);
    }
}
