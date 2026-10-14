//! `Math.asin` как в V8: порт fdlibm `__ieee754_asin` (`src/base/ieee754.cc`).
//!
//! Системный `f64::asin` (libm платформы) расходится с V8 в последнем бите, а
//! площадь сегмента круга — разность двух первообразных с `asin`, и эта
//! разность усиливает расхождение до 1e-14. Порог покрытия клетки с запасом
//! 1e-9 такое не меняет, но эталон JS сверяется побитно, поэтому формула
//! повторена дословно (константы — их битовые образы из fdlibm).

const ONE: f64 = 1.0;
const HUGE: f64 = 1.000e+300;
const PIO2_HI: f64 = f64::from_bits(0x3FF9_21FB_5444_2D18);
const PIO2_LO: f64 = f64::from_bits(0x3C91_A626_3314_5C07);
const PIO4_HI: f64 = f64::from_bits(0x3FE9_21FB_5444_2D18);
const PS0: f64 = f64::from_bits(0x3FC5_5555_5555_5555);
const PS1: f64 = f64::from_bits(0xBFD4_D612_03EB_6F7D);
const PS2: f64 = f64::from_bits(0x3FC9_C155_0E88_4455);
const PS3: f64 = f64::from_bits(0xBFA4_8228_B568_8F3B);
const PS4: f64 = f64::from_bits(0x3F49_EFE0_7501_B288);
const PS5: f64 = f64::from_bits(0x3F02_3DE1_0DFD_F709);
const QS1: f64 = f64::from_bits(0xC003_3A27_1C8A_2D4B);
const QS2: f64 = f64::from_bits(0x4000_2AE5_9C59_8AC8);
const QS3: f64 = f64::from_bits(0xBFE6_066C_1B8D_0159);
const QS4: f64 = f64::from_bits(0x3FB3_B8C5_B12E_9282);

fn high_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

fn low_word(x: f64) -> u32 {
    x.to_bits() as u32
}

fn with_low_word(x: f64, low: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0xFFFF_FFFF_0000_0000) | u64::from(low))
}

/// `Math.asin(x)` по fdlibm.
pub(crate) fn asin(x: f64) -> f64 {
    let mut t = 0.0;
    let hx = high_word(x);
    let ix = hx & 0x7FFF_FFFF;
    if ix >= 0x3FF0_0000 {
        // |x| >= 1
        if ((ix - 0x3FF0_0000) as u32 | low_word(x)) == 0 {
            // asin(±1) = ±pi/2
            return x * PIO2_HI + x * PIO2_LO;
        }
        // |x| > 1 или NaN
        return f64::NAN;
    } else if ix < 0x3FE0_0000 {
        // |x| < 0.5
        if ix < 0x3E40_0000 {
            // |x| < 2**-27
            if HUGE + x > ONE {
                return x;
            }
        } else {
            t = x * x;
        }
        let p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
        let q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
        let w = p / q;
        return x + x * w;
    }
    // 1 > |x| >= 0.5
    let w = ONE - x.abs();
    t = w * 0.5;
    let mut p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    let mut q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    let s = t.sqrt();
    if ix >= 0x3FEF_3333 {
        // |x| > 0.975
        let w = p / q;
        t = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO);
    } else {
        let w = with_low_word(s, 0);
        let c = (t - w * w) / (s + w);
        let r = p / q;
        p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
        q = PIO4_HI - 2.0 * w;
        t = PIO4_HI - (p - q);
    }
    if hx > 0 {
        t
    } else {
        -t
    }
}

#[cfg(test)]
mod tests {
    use super::asin;

    #[test]
    fn constants_match_fdlibm_decimals() {
        assert_eq!(super::PIO2_HI, 1.57079632679489655800e+00);
        assert_eq!(super::PIO2_LO, 6.12323399573676603587e-17);
        assert_eq!(super::PS1, -3.25565818622400915405e-01);
        assert_eq!(super::QS4, 7.70381505559019352791e-02);
    }

    #[test]
    fn edge_values() {
        assert_eq!(asin(0.0), 0.0);
        assert!(asin(-0.0).is_sign_negative());
        assert_eq!(asin(1.0), std::f64::consts::FRAC_PI_2);
        assert_eq!(asin(-1.0), -std::f64::consts::FRAC_PI_2);
        assert!(asin(1.5).is_nan());
        assert!(asin(f64::NAN).is_nan());
        assert_eq!(asin(0.5), 0.5235987755982989);
        assert_eq!(asin(1e-10), 1e-10);
    }
}
