const SSH_PASSWORD_SERVICE: &str = "com.fineshell.app.ssh";
const SSH_PRIVATE_KEY_PASSPHRASE_SERVICE: &str = "com.fineshell.app.ssh-key-passphrase";
const PROXY_PASSWORD_SERVICE: &str = "com.fineshell.app.proxy";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialProbe {
    kind: String,
    owner_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialProbeResult {
    kind: String,
    owner_id: String,
    exists: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyHostCredentialsResult {
    password_copied: bool,
    passphrase_copied: bool,
}

fn password_entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SSH_PASSWORD_SERVICE, host_id)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn private_key_passphrase_entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SSH_PRIVATE_KEY_PASSPHRASE_SERVICE, host_id)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn proxy_password_entry(proxy_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(PROXY_PASSWORD_SERVICE, proxy_id)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

pub(crate) fn get_private_key_passphrase(host_id: &str) -> Result<Option<String>, String> {
    match private_key_passphrase_entry(host_id)?.get_password() {
        Ok(passphrase) => Ok(Some(passphrase)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取私钥口令失败：{error}")),
    }
}

pub(crate) fn get_host_password(host_id: &str) -> Result<String, String> {
    password_entry(host_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => "未找到该主机的登录密码".to_string(),
            _ => format!("读取登录密码失败：{error}"),
        })
}

pub(crate) fn get_proxy_password(proxy_id: &str) -> Result<String, String> {
    proxy_password_entry(proxy_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => "未找到该代理的认证密码".to_string(),
            _ => format!("读取代理密码失败：{error}"),
        })
}

fn validate_copy_ids(source_host_id: &str, target_host_id: &str) -> Result<(), String> {
    if source_host_id.trim().is_empty() || target_host_id.trim().is_empty() {
        return Err("源主机标识和目标主机标识不能为空".to_string());
    }
    if source_host_id == target_host_id {
        return Err("源主机和目标主机标识不能相同".to_string());
    }
    Ok(())
}

fn copy_optional_credential(
    source: keyring::Entry,
    target: keyring::Entry,
    credential_name: &str,
) -> Result<bool, String> {
    match source.get_password() {
        Ok(value) => target
            .set_password(&value)
            .map(|_| true)
            .map_err(|error| format!("复制{credential_name}失败：{error}")),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("读取{credential_name}失败：{error}")),
    }
}

#[tauri::command]
pub(crate) fn copy_host_credentials(
    source_host_id: String,
    target_host_id: String,
) -> Result<CopyHostCredentialsResult, String> {
    validate_copy_ids(&source_host_id, &target_host_id)?;

    let password_copied = copy_optional_credential(
        password_entry(&source_host_id)?,
        password_entry(&target_host_id)?,
        "登录密码",
    )?;
    let passphrase_result = (|| {
        copy_optional_credential(
            private_key_passphrase_entry(&source_host_id)?,
            private_key_passphrase_entry(&target_host_id)?,
            "私钥口令",
        )
    })();
    let passphrase_copied = match passphrase_result {
        Ok(copied) => copied,
        Err(error) => {
            if password_copied {
                if let Ok(entry) = password_entry(&target_host_id) {
                    let _ = entry.delete_credential();
                }
            }
            return Err(error);
        }
    };

    Ok(CopyHostCredentialsResult {
        password_copied,
        passphrase_copied,
    })
}

fn credential_exists(probe: &CredentialProbe) -> Result<bool, String> {
    if probe.owner_id.trim().is_empty() {
        return Err("凭据归属标识不能为空".to_string());
    }
    let entry = match probe.kind.as_str() {
        "hostPassword" => password_entry(&probe.owner_id)?,
        "privateKeyPassphrase" => private_key_passphrase_entry(&probe.owner_id)?,
        "proxyPassword" => proxy_password_entry(&probe.owner_id)?,
        _ => return Err("不支持的凭据类型".to_string()),
    };
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("检查系统凭据失败：{error}")),
    }
}

#[tauri::command]
pub(crate) fn inspect_credentials(
    probes: Vec<CredentialProbe>,
) -> Result<Vec<CredentialProbeResult>, String> {
    probes
        .into_iter()
        .map(|probe| {
            let exists = credential_exists(&probe)?;
            Ok(CredentialProbeResult {
                kind: probe.kind,
                owner_id: probe.owner_id,
                exists,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn store_host_password(host_id: String, password: String) -> Result<(), String> {
    if host_id.trim().is_empty() || password.is_empty() {
        return Err("主机标识和密码不能为空".to_string());
    }

    password_entry(&host_id)?
        .set_password(&password)
        .map_err(|error| format!("保存登录密码失败：{error}"))
}

#[tauri::command]
pub(crate) fn delete_host_password(host_id: String) -> Result<(), String> {
    match password_entry(&host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除登录密码失败：{error}")),
    }
}

#[tauri::command]
pub(crate) fn store_private_key_passphrase(
    host_id: String,
    passphrase: String,
) -> Result<(), String> {
    if host_id.trim().is_empty() || passphrase.is_empty() {
        return Err("主机标识和私钥口令不能为空".to_string());
    }

    private_key_passphrase_entry(&host_id)?
        .set_password(&passphrase)
        .map_err(|error| format!("保存私钥口令失败：{error}"))
}

#[tauri::command]
pub(crate) fn delete_private_key_passphrase(host_id: String) -> Result<(), String> {
    match private_key_passphrase_entry(&host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除私钥口令失败：{error}")),
    }
}

#[tauri::command]
pub(crate) fn store_proxy_password(proxy_id: String, password: String) -> Result<(), String> {
    if proxy_id.trim().is_empty() || password.is_empty() {
        return Err("代理标识和密码不能为空".to_string());
    }

    proxy_password_entry(&proxy_id)?
        .set_password(&password)
        .map_err(|error| format!("保存代理密码失败：{error}"))
}

#[tauri::command]
pub(crate) fn delete_proxy_password(proxy_id: String) -> Result<(), String> {
    match proxy_password_entry(&proxy_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除代理密码失败：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{credential_exists, validate_copy_ids, CredentialProbe};

    #[test]
    fn validates_credential_copy_identifiers() {
        assert!(validate_copy_ids("source", "target").is_ok());
        assert!(validate_copy_ids("", "target").is_err());
        assert!(validate_copy_ids("same", "same").is_err());
    }

    #[test]
    fn rejects_unknown_credential_probe_kind_without_accessing_keychain() {
        let result = credential_exists(&CredentialProbe {
            kind: "unknown".to_string(),
            owner_id: "owner".to_string(),
        });
        assert_eq!(result.unwrap_err(), "不支持的凭据类型");
    }
}
