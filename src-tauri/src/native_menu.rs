#[cfg(target_os = "macos")]
use serde::Serialize;
#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{
        AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    Emitter,
};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};
#[cfg(not(target_os = "windows"))]
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
const SETTINGS_MENU_ID: &str = "settings";
#[cfg(target_os = "macos")]
const SHORTCUT_GUIDE_MENU_ID: &str = "shortcut-guide";
#[cfg(target_os = "macos")]
const SELECT_ALL_MENU_ID: &str = "select-all";
#[cfg(target_os = "macos")]
const INVERT_SELECTION_MENU_ID: &str = "invert-selection";

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectAllMenuPayload {
    invert: bool,
}

const SETTINGS_WINDOW_LABEL: &str = "settings";
const SHORTCUT_GUIDE_WINDOW_LABEL: &str = "shortcut-guide";

fn is_auxiliary_window(label: &str) -> bool {
    matches!(label, SETTINGS_WINDOW_LABEL | SHORTCUT_GUIDE_WINDOW_LABEL)
}

#[cfg(not(target_os = "windows"))]
fn create_auxiliary_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &'static str,
) -> Result<(), String> {
    let (view, title, width, height, min_width, min_height) = match label {
        SETTINGS_WINDOW_LABEL => ("settings", "设置", 860.0, 620.0, 720.0, 520.0),
        SHORTCUT_GUIDE_WINDOW_LABEL => ("shortcuts", "快捷键与操作", 780.0, 560.0, 720.0, 480.0),
        _ => return Err(format!("不支持的辅助窗口: {label}")),
    };
    let path = PathBuf::from(format!("index.html#view={view}"));
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(path))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .resizable(true)
        .focused(true)
        .center()
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn show_auxiliary_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &'static str,
) -> Result<(), String> {
    let window = app.get_webview_window(label);
    if let Some(window) = window {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        crate::diagnostics::record_native_info(
            app,
            "window",
            "辅助窗口已显示",
            Some(serde_json::json!({ "label": label })),
        );
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        create_auxiliary_window(app, label)?;
        crate::diagnostics::record_native_info(
            app,
            "window",
            "辅助窗口已创建并显示",
            Some(serde_json::json!({ "label": label })),
        );
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        Err(format!("预加载窗口 {label} 不存在，请重启 FineShell"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn base_configuration_only_preloads_the_main_window() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["label"], "main");
    }

    #[test]
    fn windows_configuration_preloads_auxiliary_windows_hidden() {
        let config: Value =
            serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert!(windows.iter().any(|window| window["label"] == "main"));
        for (label, url) in [
            ("settings", "index.html#view=settings"),
            ("shortcut-guide", "index.html#view=shortcuts"),
        ] {
            let window = windows
                .iter()
                .find(|window| window["label"] == label)
                .unwrap();
            assert_eq!(window["url"], url);
            assert_eq!(window["visible"], false);
            assert_eq!(window["focus"], false);
        }
    }
}

fn show_settings_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    show_auxiliary_window(app, SETTINGS_WINDOW_LABEL)
}

fn show_shortcut_guide_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    show_auxiliary_window(app, SHORTCUT_GUIDE_WINDOW_LABEL)
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app)
}

#[tauri::command]
pub async fn open_shortcut_guide_window(app: AppHandle) -> Result<(), String> {
    show_shortcut_guide_window(&app)
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if is_auxiliary_window(window.label()) {
            api.prevent_close();
            let _ = window.hide();
            if let Some(main_window) = window.app_handle().get_webview_window("main") {
                let _ = main_window.set_focus();
            }
        }

        #[cfg(not(target_os = "macos"))]
        if window.label() == "main" {
            window.app_handle().exit(0);
        }
    }
}

#[cfg(target_os = "macos")]
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == SELECT_ALL_MENU_ID || event.id() == INVERT_SELECTION_MENU_ID {
        if let Some(window) = app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
        {
            let _ = window.emit(
                crate::protocol::MENU_SELECT_ALL_EVENT,
                SelectAllMenuPayload {
                    invert: event.id() == INVERT_SELECTION_MENU_ID,
                },
            );
        }
        return;
    }

    let result = if event.id() == SETTINGS_MENU_ID {
        show_settings_window(app)
    } else if event.id() == SHORTCUT_GUIDE_MENU_ID {
        show_shortcut_guide_window(app)
    } else {
        return;
    };

    if let Err(error) = result {
        crate::diagnostics::record_native_error(
            app,
            "window.auxiliary",
            "无法打开辅助窗口",
            Some(serde_json::json!({ "error": error })),
        );
    }
}

#[cfg(target_os = "macos")]
pub fn build_chinese_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some("FineShell".to_string()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "帮助",
        true,
        &[
            &MenuItem::with_id(
                app,
                SHORTCUT_GUIDE_MENU_ID,
                "快捷键与操作…",
                true,
                None::<&str>,
            )?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, Some("关于 FineShell"), Some(about_metadata.clone()))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "FineShell",
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some("关于 FineShell"),
                        Some(about_metadata.clone()),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, SETTINGS_MENU_ID, "设置…", true, Some("CmdOrCtrl+,"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, Some("服务"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some("隐藏 FineShell"))?,
                    &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
                    &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("退出 FineShell"))?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app,
                "文件",
                true,
                &[
                    &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, Some("退出 FineShell"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &MenuItem::with_id(app, SETTINGS_MENU_ID, "设置…", true, Some("CmdOrCtrl+,"))?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::undo(app, Some("撤销"))?,
                    &PredefinedMenuItem::redo(app, Some("重做"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("剪切"))?,
                    &PredefinedMenuItem::copy(app, Some("复制"))?,
                    &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                    &MenuItem::with_id(app, SELECT_ALL_MENU_ID, "全选", true, Some("CmdOrCtrl+A"))?,
                    &MenuItem::with_id(
                        app,
                        INVERT_SELECTION_MENU_ID,
                        "反选",
                        true,
                        Some("CmdOrCtrl+Shift+A"),
                    )?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "显示",
                true,
                &[&PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}
