mod config_files;
mod credentials;
mod monitor;
mod sftp;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(sftp::SftpSessionManager::default())
        .manage(ssh::SshSessionManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            config_files::read_config_file,
            config_files::write_config_file,
            credentials::store_host_password,
            credentials::delete_host_password,
            credentials::copy_host_credentials,
            credentials::store_private_key_passphrase,
            credentials::delete_private_key_passphrase,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_monitor_snapshot,
            ssh::ssh_disconnect,
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_create_directory,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
