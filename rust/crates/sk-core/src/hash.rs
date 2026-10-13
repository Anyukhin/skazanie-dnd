//! Хеши (`createHash('sha256')`) и идентификаторы (`randomUUID`).

use sha2::{Digest, Sha256};

/// `createHash('sha256').update(text).digest('hex')`.
pub fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(data.as_ref()))
}

/// Сырые 32 байта SHA-256.
pub fn sha256(data: impl AsRef<[u8]>) -> [u8; 32] {
    Sha256::digest(data.as_ref()).into()
}

/// `randomUUID()`.
pub fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn sha256_matches_node() {
        assert_eq!(super::sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(super::uuid_v4().len(), 36);
    }
}
