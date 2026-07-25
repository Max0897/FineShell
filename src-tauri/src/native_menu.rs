use serde::Serialize;
use tauri::{
    menu::{
        AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const SETTINGS_MENU_ID: &str = "settings";
const SELECT_ALL_MENU_ID: &str = "select-all";
const INVERT_SELECTION_MENU_ID: &str = "invert-selection";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectAllMenuPayload {
    invert: bool,
}

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

    if event.id() != SETTINGS_MENU_ID {
        return;
    }

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let result = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("设置")
    .inner_size(860.0, 620.0)
    .min_inner_size(720.0, 520.0)
    .resizable(true)
    .focused(true)
    .center()
    .build();

    if let Err(error) = result {
        eprintln!("无法打开设置窗口: {error}");
    }
}

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
