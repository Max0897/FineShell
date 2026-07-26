#[cfg(target_os = "macos")]
use serde::Serialize;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{
        AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    Emitter,
};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

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

#[derive(Clone, Copy)]
struct AuxiliaryWindowSpec {
    label: &'static str,
    view: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

const SETTINGS_WINDOW: AuxiliaryWindowSpec = AuxiliaryWindowSpec {
    label: "settings",
    view: "settings",
    title: "设置",
    width: 860.0,
    height: 620.0,
    min_width: 720.0,
    min_height: 520.0,
};

const SHORTCUT_GUIDE_WINDOW: AuxiliaryWindowSpec = AuxiliaryWindowSpec {
    label: "shortcut-guide",
    view: "shortcuts",
    title: "快捷键与操作",
    width: 780.0,
    height: 560.0,
    min_width: 720.0,
    min_height: 480.0,
};

fn auxiliary_window_path(spec: AuxiliaryWindowSpec) -> PathBuf {
    // Keep the view selector in the fragment so it never becomes part of the
    // local asset request handled by WebView2 on Windows.
    format!("index.html#view={}", spec.view).into()
}

fn show_auxiliary_window<R: Runtime>(
    app: &AppHandle<R>,
    spec: AuxiliaryWindowSpec,
) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(spec.label) {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        spec.label,
        WebviewUrl::App(auxiliary_window_path(spec)),
    )
    .title(spec.title)
    .inner_size(spec.width, spec.height)
    .min_inner_size(spec.min_width, spec.min_height)
    .resizable(true)
    .focused(true)
    .center()
    .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{auxiliary_window_path, SETTINGS_WINDOW, SHORTCUT_GUIDE_WINDOW};

    #[test]
    fn auxiliary_window_routes_do_not_put_queries_in_asset_paths() {
        assert_eq!(
            auxiliary_window_path(SETTINGS_WINDOW).to_string_lossy(),
            "index.html#view=settings"
        );
        assert_eq!(
            auxiliary_window_path(SHORTCUT_GUIDE_WINDOW).to_string_lossy(),
            "index.html#view=shortcuts"
        );
        assert!(!auxiliary_window_path(SETTINGS_WINDOW)
            .to_string_lossy()
            .contains('?'));
    }
}

fn show_settings_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    show_auxiliary_window(app, SETTINGS_WINDOW)
}

fn show_shortcut_guide_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    show_auxiliary_window(app, SHORTCUT_GUIDE_WINDOW)
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_shortcut_guide_window(app: AppHandle) -> Result<(), String> {
    show_shortcut_guide_window(&app).map_err(|error| error.to_string())
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
        eprintln!("无法打开辅助窗口: {error}");
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
