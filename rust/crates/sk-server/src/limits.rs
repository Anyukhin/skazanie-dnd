//! Окна запросов — `server/index.mjs:2895–2904`.
//!
//! - [`Limits::rate_limited`] — `rateLimited(req)`: двадцать попыток входа
//!   (и голосового ввода) за десять минут с адреса сокета;
//! - [`Limits::exceeds_rate`] — `exceedsRate(key, limit, windowMs)`
//!   (`costlyRequests`): дорогие запросы по ключу вида `narrate:<user>`.

use std::net::SocketAddr;

use crate::rate_window::{SlidingWindowCounter, RATE_WINDOW_MS};
use crate::state::Clock;

/// `loginAttempts` и `costlyRequests`.
pub struct Limits {
    login_attempts: SlidingWindowCounter,
    costly_requests: SlidingWindowCounter,
}

impl Limits {
    pub fn new(clock: Clock) -> Self {
        Self { login_attempts: SlidingWindowCounter::new(RATE_WINDOW_MS, 1_000, clock.clone()), costly_requests: SlidingWindowCounter::new(RATE_WINDOW_MS, 1_000, clock) }
    }

    /// `loginAttempts.hit(req.socket.remoteAddress || 'unknown', 20)`.
    pub fn rate_limited(&self, peer: Option<SocketAddr>) -> bool {
        self.login_attempts.hit(&remote_address(peer), 20, None)
    }

    /// `costlyRequests.hit(key, limit, windowMs)`; `true` — предел превышен.
    pub fn exceeds_rate(&self, key: &str, limit: usize, window_ms: Option<i64>) -> bool {
        self.costly_requests.hit(key, limit, Some(window_ms.unwrap_or(RATE_WINDOW_MS)))
    }
}

/// `req.socket.remoteAddress || 'unknown'`: адрес без порта; IPv4,
/// отображённый в IPv6, Node печатает как `::ffff:1.2.3.4`.
pub fn remote_address(peer: Option<SocketAddr>) -> String {
    peer.map_or_else(|| "unknown".to_string(), |address| address.ip().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn twenty_logins_per_address() {
        let limits = Limits::new(Arc::new(|| 1_000));
        let first: SocketAddr = "10.0.0.1:5000".parse().unwrap_or_else(|_| SocketAddr::from(([10, 0, 0, 1], 5000)));
        let second: SocketAddr = "10.0.0.2:5000".parse().unwrap_or_else(|_| SocketAddr::from(([10, 0, 0, 2], 5000)));
        for _ in 0..20 {
            assert!(!limits.rate_limited(Some(first)));
        }
        assert!(limits.rate_limited(Some(first)), "двадцать первая попытка — отказ");
        assert!(!limits.rate_limited(Some(second)), "окно — на адрес, не на порт и не общее");
        assert_eq!(remote_address(None), "unknown");
        assert!(!limits.exceeds_rate("narrate:u", 1, None));
        assert!(limits.exceeds_rate("narrate:u", 1, None));
    }
}
