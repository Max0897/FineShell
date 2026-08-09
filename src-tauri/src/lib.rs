mod agent;
mod agent_actions;
mod agent_approvals;
mod agent_executor;
mod agent_policy;
mod agent_verification;
mod ai;
mod ai_rig;
mod cloud_backup;
mod config_files;
mod credentials;
mod diagnostics;
mod dynamic_forward;
mod external_edit;
mod managed_keys;
mod monitor;
#[cfg(desktop)]
mod native_menu;
mod protocol;
mod sftp;
mod ssh;
mod terminal_logs;
mod transport;
#[cfg(desktop)]
mod updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_target = tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
        file_name: Some("fineshell".into()),
    })
    .filter(|metadata| metadata.target().starts_with("fineshell"));
    let mut log_builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(log_target)
        .level(log::LevelFilter::Trace)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5));
    #[cfg(debug_assertions)]
    {
        log_builder = log_builder.target(
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout)
                .filter(|metadata| metadata.target().starts_with("fineshell")),
        );
    }

    let builder = tauri::Builder::default()
        .manage(ai::AiRequestManager::default())
        .manage(agent::AgentTaskManager::default())
        .manage(cloud_backup::CloudBackupManager::default())
        .manage(sftp::SftpSessionManager::default())
        .manage(diagnostics::DiagnosticLogState::default())
        .manage(external_edit::ExternalEditManager::default())
        .manage(ssh::SshSessionManager::default())
        .manage(terminal_logs::TerminalLogManager::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(log_builder.build());

    #[cfg(desktop)]
    let builder = builder
        .manage(updater::ApplicationUpdateManager::default())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder.setup(|app| {
        managed_keys::initialize(app.handle()).map_err(std::io::Error::other)?;
        agent::initialize(app.handle()).map_err(std::io::Error::other)?;
        diagnostics::record_startup(app.handle());
        Ok(())
    });

    #[cfg(desktop)]
    let builder = builder.on_window_event(native_menu::handle_window_event);

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(native_menu::build_chinese_menu)
        .on_menu_event(native_menu::handle_menu_event);

    let app = builder
        .invoke_handler(tauri::generate_handler![
            protocol::protocol_version,
            #[cfg(desktop)]
            native_menu::open_settings_window,
            #[cfg(desktop)]
            native_menu::open_shortcut_guide_window,
            #[cfg(desktop)]
            updater::application_update_check,
            #[cfg(desktop)]
            updater::application_update_download_and_install,
            #[cfg(desktop)]
            updater::application_update_close,
            #[cfg(desktop)]
            updater::application_update_test_route,
            config_files::read_config_file,
            config_files::write_config_file,
            cloud_backup::cloud_backup_store_s3_credentials,
            cloud_backup::cloud_backup_delete_s3_credentials,
            cloud_backup::cloud_backup_s3_credential_status,
            cloud_backup::cloud_backup_test_connection,
            cloud_backup::cloud_backup_repository_status,
            cloud_backup::cloud_backup_initialize_repository,
            cloud_backup::cloud_backup_unlock_repository,
            cloud_backup::cloud_backup_list_snapshots,
            cloud_backup::cloud_backup_create_snapshot,
            cloud_backup::cloud_backup_download_snapshot,
            cloud_backup::cloud_backup_apply_credentials,
            cloud_backup::cloud_backup_discard_restore,
            cloud_backup::cloud_backup_delete_snapshot,
            credentials::store_host_password,
            credentials::delete_host_password,
            credentials::copy_host_credentials,
            credentials::inspect_credentials,
            credentials::store_private_key_passphrase,
            credentials::delete_private_key_passphrase,
            credentials::store_proxy_password,
            credentials::delete_proxy_password,
            credentials::store_ai_api_key,
            credentials::delete_ai_api_key,
            credentials::ai_api_key_status,
            ai::ai_list_models,
            ai::ai_test_connection,
            ai::ai_probe_capabilities,
            ai::ai_chat_start,
            ai::ai_chat_cancel,
            ai::ai_task_action_results,
            agent::ai_task_get,
            agent::ai_task_events_since,
            agent::ai_task_sync,
            agent::ai_task_recovery_decide,
            agent::ai_task_plan_decide,
            agent::ai_task_action_transition,
            agent::ai_task_command_observe,
            agent_executor::ai_task_action_execute,
            managed_keys::managed_ssh_key_import,
            managed_keys::managed_ssh_key_delete,
            diagnostics::diagnostic_set_level,
            diagnostics::diagnostic_record,
            diagnostics::diagnostic_open_log,
            diagnostics::diagnostic_open_log_directory,
            terminal_logs::terminal_log_start,
            terminal_logs::terminal_log_default_directory,
            terminal_logs::terminal_log_append,
            terminal_logs::terminal_log_marker,
            terminal_logs::terminal_log_stop,
            terminal_logs::terminal_log_open_directory,
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
            sftp::sftp_ensure_upload_directories,
            sftp::sftp_create_file,
            sftp::sftp_rename,
            sftp::sftp_copy,
            sftp::sftp_delete,
            sftp::sftp_fast_delete,
            sftp::sftp_set_permissions,
            sftp::sftp_set_owner,
            sftp::sftp_create_archive,
            sftp::sftp_extract_archive,
            sftp::sftp_read_text_file,
            sftp::sftp_write_text_file,
            sftp::sftp_apply_ai_file_operation,
            external_edit::sftp_start_external_edit,
            external_edit::sftp_external_edit_action,
            external_edit::sftp_close_external_edits,
            external_edit::sftp_launch_external_editor,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_download_archive,
            sftp::sftp_pause_transfer,
            sftp::sftp_resume_transfer,
            sftp::sftp_cancel_transfer,
            sftp::sftp_disconnect,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        native_menu::handle_run_event(app, event);

        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
