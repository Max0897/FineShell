use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};

use super::types::WrappedMasterKey;

const MASTER_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

pub(crate) fn random_master_key() -> [u8; MASTER_KEY_LEN] {
    let mut key = [0_u8; MASTER_KEY_LEN];
    OsRng.fill_bytes(&mut key);
    key
}

pub(crate) fn generate_recovery_key() -> String {
    let mut bytes = [0_u8; MASTER_KEY_LEN];
    OsRng.fill_bytes(&mut bytes);
    let raw = bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    raw.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize_secret(secret: &str, recovery_key: bool) -> String {
    if recovery_key {
        secret
            .chars()
            .filter(|character| !character.is_ascii_whitespace() && *character != '-')
            .collect::<String>()
            .to_ascii_uppercase()
    } else {
        secret.to_string()
    }
}

fn derive_key(secret: &str, salt: &[u8]) -> Result<[u8; MASTER_KEY_LEN], String> {
    let mut key = [0_u8; MASTER_KEY_LEN];
    Argon2::default()
        .hash_password_into(secret.as_bytes(), salt, &mut key)
        .map_err(|error| format!("生成备份加密密钥失败：{error}"))?;
    Ok(key)
}

pub(crate) fn wrap_master_key(
    master_key: &[u8; MASTER_KEY_LEN],
    secret: &str,
    recovery_key: bool,
) -> Result<WrappedMasterKey, String> {
    let normalized = normalize_secret(secret, recovery_key);
    if normalized.len() < 8 {
        return Err(if recovery_key {
            "恢复密钥格式无效".to_string()
        } else {
            "备份密码至少需要 8 个字符".to_string()
        });
    }
    let mut salt = [0_u8; SALT_LEN];
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let wrap_key = derive_key(&normalized, &salt)?;
    let cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), master_key.as_slice())
        .map_err(|_| "加密备份主密钥失败".to_string())?;
    Ok(WrappedMasterKey {
        algorithm: "XChaCha20-Poly1305".to_string(),
        kdf: "Argon2id".to_string(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

pub(crate) fn unwrap_master_key(
    wrapped: &WrappedMasterKey,
    secret: &str,
    recovery_key: bool,
) -> Result<[u8; MASTER_KEY_LEN], String> {
    let salt = STANDARD
        .decode(&wrapped.salt)
        .map_err(|_| "云端仓库的密钥盐值无效".to_string())?;
    let nonce = STANDARD
        .decode(&wrapped.nonce)
        .map_err(|_| "云端仓库的密钥随机数无效".to_string())?;
    let ciphertext = STANDARD
        .decode(&wrapped.ciphertext)
        .map_err(|_| "云端仓库的加密主密钥无效".to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("云端仓库的密钥随机数长度无效".to_string());
    }
    let normalized = normalize_secret(secret, recovery_key);
    let wrap_key = derive_key(&normalized, &salt)?;
    let cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "备份密码或恢复密钥不正确".to_string())?;
    plaintext
        .try_into()
        .map_err(|_| "云端仓库的主密钥长度无效".to_string())
}

pub(crate) fn encrypt_payload(
    master_key: &[u8; MASTER_KEY_LEN],
    plaintext: &[u8],
) -> Result<(String, String), String> {
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(master_key.into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| "加密云备份失败".to_string())?;
    Ok((STANDARD.encode(nonce), STANDARD.encode(ciphertext)))
}

pub(crate) fn decrypt_payload(
    master_key: &[u8; MASTER_KEY_LEN],
    nonce: &str,
    ciphertext: &str,
) -> Result<Vec<u8>, String> {
    let nonce = STANDARD
        .decode(nonce)
        .map_err(|_| "备份随机数无效".to_string())?;
    let ciphertext = STANDARD
        .decode(ciphertext)
        .map_err(|_| "备份密文无效".to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("备份随机数长度无效".to_string());
    }
    XChaCha20Poly1305::new(master_key.into())
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "云备份解密失败，请重新解锁仓库".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        decrypt_payload, encrypt_payload, generate_recovery_key, random_master_key,
        unwrap_master_key, wrap_master_key,
    };

    #[test]
    fn wraps_and_unwraps_master_key_with_password() {
        let master = random_master_key();
        let wrapped = wrap_master_key(&master, "a-strong-password", false).unwrap();
        assert_eq!(
            unwrap_master_key(&wrapped, "a-strong-password", false).unwrap(),
            master
        );
        assert!(unwrap_master_key(&wrapped, "wrong-password", false).is_err());
    }

    #[test]
    fn recovery_key_is_human_grouped_and_normalized() {
        let master = random_master_key();
        let recovery_key = generate_recovery_key();
        let wrapped = wrap_master_key(&master, &recovery_key, true).unwrap();
        assert_eq!(
            unwrap_master_key(&wrapped, &recovery_key.to_ascii_lowercase(), true).unwrap(),
            master
        );
    }

    #[test]
    fn encrypts_and_decrypts_snapshot_payload() {
        let master = random_master_key();
        let (nonce, encrypted) = encrypt_payload(&master, b"configuration").unwrap();
        assert_eq!(
            decrypt_payload(&master, &nonce, &encrypted).unwrap(),
            b"configuration"
        );
    }
}
