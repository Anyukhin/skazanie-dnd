//! `x ** y` для весов добора — так, как его даёт Node.
//!
//! V8 не считает `Math.pow` сам: `base::ieee754::pow` разбирает особые
//! значения ECMAScript и зовёт `std::pow` платформы (UCRT на Windows, glibc в
//! боевом Docker). Оба на области расстановки — `(1 + count) ** 1.6` для целых
//! `count` — округляют верно, и Node на машине владельца совпадает с точным
//! значением для всех оснований 1…20000 (эталон `fixtures/prop-placement.json`,
//! разделы `pow` и `powTail`). Системный `f64::powf` Rust (mingw) ошибается в
//! последнем бите уже на `6 ** 1.6`, порт fdlibm `e_pow.c` — на `26 ** 1.6`, а
//! сумма весов решает, какой предмет выпадет.
//!
//! Поэтому для положительного конечного основания степень считается в
//! двойной-двойной точности (`exp(y · ln x)` по алгоритмам библиотеки QD,
//! около 100 бит) и округляется до `f64` — верно округлённый результат, не
//! зависящий от платформы. Вне этой области (ноль, отрицательное основание,
//! переполнение) — `f64::powf` с поправками ECMAScript: расстановке такие
//! значения не встречаются.

/// Число двойной-двойной точности: `hi + lo`, `|lo| ≤ ulp(hi) / 2`.
#[derive(Clone, Copy, Debug)]
struct Dd {
    hi: f64,
    lo: f64,
}

fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let sum = a + b;
    let bb = sum - a;
    (sum, (a - (sum - bb)) + (b - bb))
}

fn quick_two_sum(a: f64, b: f64) -> (f64, f64) {
    let sum = a + b;
    (sum, b - (sum - a))
}

/// Разбиение Деккера: без `fma`, только базовые операции IEEE.
fn split(a: f64) -> (f64, f64) {
    let t = 134_217_729.0 * a;
    let hi = t - (t - a);
    (hi, a - hi)
}

fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let product = a * b;
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    (product, ((ah * bh - product) + ah * bl + al * bh) + al * bl)
}

impl Dd {
    const fn new(hi: f64, lo: f64) -> Self {
        Self { hi, lo }
    }

    fn from_pair((hi, lo): (f64, f64)) -> Self {
        Self { hi, lo }
    }

    fn add(self, other: Dd) -> Dd {
        let (s1, s2) = two_sum(self.hi, other.hi);
        let (t1, t2) = two_sum(self.lo, other.lo);
        let (s1, s2) = quick_two_sum(s1, s2 + t1);
        Dd::from_pair(quick_two_sum(s1, s2 + t2))
    }

    fn add_f(self, other: f64) -> Dd {
        let (s1, s2) = two_sum(self.hi, other);
        Dd::from_pair(quick_two_sum(s1, s2 + self.lo))
    }

    fn neg(self) -> Dd {
        Dd::new(-self.hi, -self.lo)
    }

    fn mul(self, other: Dd) -> Dd {
        let (p1, p2) = two_prod(self.hi, other.hi);
        Dd::from_pair(quick_two_sum(p1, p2 + (self.hi * other.lo + self.lo * other.hi)))
    }

    fn mul_f(self, other: f64) -> Dd {
        let (p1, p2) = two_prod(self.hi, other);
        Dd::from_pair(quick_two_sum(p1, p2 + self.lo * other))
    }

    /// Умножение на степень двойки — точное.
    fn scale(self, power: f64) -> Dd {
        Dd::new(self.hi * power, self.lo * power)
    }

    fn div_f(self, other: f64) -> Dd {
        let q1 = self.hi / other;
        let (p1, p2) = two_prod(q1, other);
        let (s, e) = two_sum(self.hi, -p1);
        let e = e + self.lo - p2;
        let q2 = (s + e) / other;
        Dd::from_pair(quick_two_sum(q1, q2))
    }
}

/// ln 2 в двойной-двойной точности (QD `_log2`).
const LOG2: Dd = Dd::new(6.931_471_805_599_452_862e-01, 2.319_046_813_846_299_558e-17);
/// 2⁻¹⁰⁴ — точность двойной-двойной арифметики (QD `_eps`).
const EPS: f64 = 4.930_380_657_631_32e-32;
/// Приведение аргумента экспоненты делением на 2⁹ (QD `k = 512`).
const INV_K: f64 = 1.0 / 512.0;

/// `2 ** exponent` для показателя нормального диапазона.
fn power_of_two(exponent: i64) -> f64 {
    f64::from_bits(((exponent + 1023) as u64) << 52)
}

/// `exp(a)` (QD `dd_real::exp`): приведение по ln 2 и делению на 512, ряд
/// Тейлора, девять возведений в квадрат. `None` — вне нормального диапазона.
fn dd_exp(a: Dd) -> Option<Dd> {
    if !(a.hi > -700.0 && a.hi < 700.0) {
        return None;
    }
    if a.hi == 0.0 && a.lo == 0.0 {
        return Some(Dd::new(1.0, 0.0));
    }
    let m = (a.hi / LOG2.hi + 0.5).floor();
    let r = a.add(LOG2.mul_f(m).neg()).scale(INV_K);
    // 1/3!, 1/4!, … в двойной-двойной точности: факториалы до 18! точны в f64.
    let mut factorial = 2.0;
    let mut next_inverse_factorial = |index: usize| {
        factorial *= (index + 3) as f64;
        Dd::new(1.0, 0.0).div_f(factorial)
    };
    let mut p = r.mul(r);
    let mut s = r.add(p.scale(0.5));
    p = p.mul(r);
    let mut t = p.mul(next_inverse_factorial(0));
    let mut index = 0;
    loop {
        s = s.add(t);
        p = p.mul(r);
        index += 1;
        t = p.mul(next_inverse_factorial(index));
        if !(t.hi.abs() > INV_K * EPS && index < 5) {
            break;
        }
    }
    s = s.add(t);
    for _ in 0..9 {
        s = s.scale(2.0).add(s.mul(s));
    }
    s = s.add_f(1.0);
    Some(s.scale(power_of_two(m as i64)))
}

/// `ln(x)` для положительного конечного `x` (QD `dd_real::log`): одно
/// приближение Ньютона от `f64::ln` удваивает точность, и итог не зависит от
/// последнего бита начального приближения.
fn dd_log(x: f64) -> Option<Dd> {
    if x == 1.0 {
        return Some(Dd::new(0.0, 0.0));
    }
    let guess = Dd::new(x.ln(), 0.0);
    let correction = dd_exp(guess.neg())?.mul_f(x);
    Some(guess.add(correction).add_f(-1.0))
}

/// Верно округлённое `x ** y` для положительного конечного `x`; `None` —
/// вне области (переполнение, исчезновение порядка).
fn correctly_rounded_pow(x: f64, y: f64) -> Option<f64> {
    let logarithm = dd_log(x)?;
    let power = dd_exp(logarithm.mul_f(y))?;
    power.hi.is_normal().then_some(power.hi)
}

/// `Math.pow(x, y)` / `x ** y`.
pub(crate) fn js_pow(x: f64, y: f64) -> f64 {
    // Особые значения ECMAScript поверх C: NaN в степени и (±1) ** ±∞ — NaN.
    if y.is_nan() {
        return f64::NAN;
    }
    if y.is_infinite() && (x == 1.0 || x == -1.0) {
        return f64::NAN;
    }
    if y == 0.0 {
        return 1.0;
    }
    if x > 0.0 && x.is_finite() && y.is_finite() {
        if let Some(power) = correctly_rounded_pow(x, y) {
            return power;
        }
    }
    x.powf(y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_values_follow_ecmascript() {
        assert_eq!(js_pow(2.0, 10.0), 1024.0);
        assert_eq!(js_pow(9.0, 0.5), 3.0);
        assert_eq!(js_pow(1.0, 1.6), 1.0);
        assert_eq!(js_pow(5.0, 0.0), 1.0);
        assert_eq!(js_pow(f64::NAN, 0.0), 1.0);
        assert!(js_pow(1.0, f64::INFINITY).is_nan());
        assert!(js_pow(-1.0, f64::NEG_INFINITY).is_nan());
        assert!(js_pow(2.0, f64::NAN).is_nan());
        assert!(js_pow(-8.0, 1.6).is_nan());
        assert_eq!(js_pow(-2.0, 3.0), -8.0);
        assert_eq!(js_pow(0.0, -1.0), f64::INFINITY);
        assert_eq!(js_pow(10.0, 400.0), f64::INFINITY);
        assert_eq!(js_pow(4.0, 2.5), 32.0);
    }

    #[test]
    fn constants_are_qd_bit_patterns() {
        assert_eq!(LOG2.hi.to_bits(), 0x3FE6_2E42_FEFA_39EF);
        assert_eq!(LOG2.lo.to_bits(), 0x3C7A_BC9E_3B39_803F);
    }
}

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
