mod credentials;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ssh::SshSessionManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            credentials::store_host_password,
            credentials::delete_host_password,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
