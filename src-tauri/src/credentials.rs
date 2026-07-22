const SSH_PASSWORD_SERVICE: &str = "com.fineshell.app.ssh";

fn password_entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SSH_PASSWORD_SERVICE, host_id)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

pub(crate) fn get_host_password(host_id: &str) -> Result<String, String> {
    password_entry(host_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => "未找到该主机的登录密码".to_string(),
            _ => format!("读取登录密码失败：{error}"),
        })
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
