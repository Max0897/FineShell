mod config_files;
mod credentials;
mod dynamic_forward;
mod external_edit;
mod monitor;
#[cfg(desktop)]
mod native_menu;
mod sftp;
mod ssh;
mod transport;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(sftp::SftpSessionManager::default())
        .manage(external_edit::ExternalEditManager::default())
        .manage(ssh::SshSessionManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .menu(native_menu::build_chinese_menu)
        .on_menu_event(native_menu::handle_menu_event);

    builder
        .invoke_handler(tauri::generate_handler![
            config_files::read_config_file,
            config_files::write_config_file,
            credentials::store_host_password,
            credentials::delete_host_password,
            credentials::copy_host_credentials,
            credentials::store_private_key_passphrase,
            credentials::delete_private_key_passphrase,
            credentials::store_proxy_password,
            credentials::delete_proxy_password,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_monitor_snapshot,
            ssh::ssh_ping,
            ssh::ssh_network_connections,
            ssh::ssh_trace_route,
            ssh::ssh_processes,
            ssh::ssh_signal_process,
            ssh::ssh_start_local_forward,
            ssh::ssh_stop_local_forward,
            ssh::ssh_start_remote_forward,
            ssh::ssh_stop_remote_forward,
            ssh::ssh_start_dynamic_forward,
            ssh::ssh_stop_dynamic_forward,
            ssh::ssh_disconnect,
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_inspect_upload_paths,
            sftp::sftp_create_directory,
            sftp::sftp_create_file,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_fast_delete,
            sftp::sftp_set_permissions,
            sftp::sftp_read_text_file,
            sftp::sftp_write_text_file,
            external_edit::sftp_start_external_edit,
            external_edit::sftp_external_edit_action,
            external_edit::sftp_launch_external_editor,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_pause_transfer,
            sftp::sftp_resume_transfer,
            sftp::sftp_cancel_transfer,
            sftp::sftp_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
