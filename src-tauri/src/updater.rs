use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::protocol::{CommandError, CommandResult};

const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const FINESHELL_LATEST_RELEASE_URL: &str =
    "https://github.com/Max0897/fineshell/releases/latest/download/latest.json";
const BUILTIN_MIRRORS: [(&str, &str); 2] = [
    ("gh-proxy.com", "https://gh-proxy.com/"),
    ("ghproxy.net", "https://ghproxy.net/"),
];

#[derive(Default)]
pub(crate) struct ApplicationUpdateManager {
    next_id: AtomicU64,
    pending: Mutex<Option<PendingUpdate>>,
}

struct PendingUpdate {
    direct_download_url: Url,
    route: String,
    update: Update,
    update_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationUpdateRequest {
    route: String,
    custom_url: Option<String>,
}

#[derive(Clone, Debug)]
struct UpdateRoute {
    label: String,
    prefix: Option<Url>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationUpdateMetadata {
    body: Option<String>,
    current_version: String,
    date: Option<String>,
    route: String,
    update_id: u64,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationUpdateRouteTestResult {
    latency_ms: u128,
    route: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum ApplicationUpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
    Fallback {
        route: String,
    },
}

fn command_error(operation: &'static str, error: impl std::fmt::Display) -> CommandError {
    CommandError::from_message(operation, error.to_string())
}

fn normalized_mirror_prefix(value: &str) -> Result<Url, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("自定义镜像地址不能为空".to_string());
    }
    if value.len() > 512 {
        return Err("自定义镜像地址过长".to_string());
    }
    let normalized = if value.ends_with('/') {
        value.to_string()
    } else {
        format!("{value}/")
    };
    let url = Url::parse(&normalized).map_err(|error| format!("镜像地址无效：{error}"))?;
    if url.scheme() != "https" {
        return Err("镜像地址必须使用 HTTPS".to_string());
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("镜像地址格式不受支持".to_string());
    }
    Ok(url)
}

fn direct_route() -> UpdateRoute {
    UpdateRoute {
        label: "GitHub 直连".to_string(),
        prefix: None,
    }
}

fn builtin_route(name: &str) -> Option<UpdateRoute> {
    BUILTIN_MIRRORS
        .iter()
        .find(|(route, _)| *route == name)
        .map(|(route, prefix)| UpdateRoute {
            label: (*route).to_string(),
            prefix: Some(Url::parse(prefix).expect("built-in updater mirror URL must be valid")),
        })
}

fn update_routes(request: &ApplicationUpdateRequest) -> Result<Vec<UpdateRoute>, String> {
    let mut routes = match request.route.as_str() {
        "auto" => BUILTIN_MIRRORS
            .iter()
            .map(|(name, _)| builtin_route(name).expect("built-in route must exist"))
            .collect::<Vec<_>>(),
        "direct" => Vec::new(),
        "custom" => vec![UpdateRoute {
            label: "自定义镜像".to_string(),
            prefix: Some(normalized_mirror_prefix(
                request.custom_url.as_deref().unwrap_or_default(),
            )?),
        }],
        route => vec![builtin_route(route).ok_or_else(|| "更新线路无效".to_string())?],
    };
    routes.push(direct_route());
    Ok(routes)
}

fn mirrored_url(prefix: &Url, source: &Url) -> Result<Url, String> {
    Url::parse(&format!("{}{}", prefix.as_str(), source.as_str()))
        .map_err(|error| format!("无法生成镜像地址：{error}"))
}

fn route_url(route: &UpdateRoute, source: &Url) -> Result<Url, String> {
    match route.prefix.as_ref() {
        Some(prefix) => mirrored_url(prefix, source),
        None => Ok(source.clone()),
    }
}

fn validate_fineshell_download_url(url: &Url) -> Result<(), String> {
    let path = url.path().to_ascii_lowercase();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !path.starts_with("/max0897/fineshell/releases/download/")
    {
        return Err("更新清单包含不受信任的下载地址".to_string());
    }
    Ok(())
}

fn lock_pending(
    manager: &ApplicationUpdateManager,
) -> Result<std::sync::MutexGuard<'_, Option<PendingUpdate>>, String> {
    manager
        .pending
        .lock()
        .map_err(|_| "更新状态不可用".to_string())
}

#[tauri::command]
pub(crate) async fn application_update_check(
    app: AppHandle,
    manager: State<'_, ApplicationUpdateManager>,
    request: ApplicationUpdateRequest,
) -> CommandResult<Option<ApplicationUpdateMetadata>> {
    const OPERATION: &str = "application_update_check";
    let routes = update_routes(&request).map_err(|error| command_error(OPERATION, error))?;
    let source = Url::parse(FINESHELL_LATEST_RELEASE_URL)
        .map_err(|error| command_error(OPERATION, error))?;
    *lock_pending(&manager).map_err(|error| command_error(OPERATION, error))? = None;

    let mut last_error = None;
    for route in routes {
        let endpoint = match route_url(&route, &source) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let updater = match app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map(|builder| builder.timeout(CHECK_TIMEOUT))
            .and_then(|builder| builder.build())
        {
            Ok(updater) => updater,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };

        match updater.check().await {
            Ok(None) => return Ok(None),
            Ok(Some(mut update)) => {
                if let Err(error) = validate_fineshell_download_url(&update.download_url) {
                    last_error = Some(error);
                    continue;
                }
                let direct_download_url = update.download_url.clone();
                if let Some(prefix) = route.prefix.as_ref() {
                    update.download_url = mirrored_url(prefix, &direct_download_url)
                        .map_err(|error| command_error(OPERATION, error))?;
                }
                update.timeout = Some(DOWNLOAD_TIMEOUT);
                let update_id = manager.next_id.fetch_add(1, Ordering::Relaxed) + 1;
                let metadata = ApplicationUpdateMetadata {
                    body: update.body.clone(),
                    current_version: update.current_version.clone(),
                    date: update.date.and_then(|date| {
                        date.format(&time::format_description::well_known::Rfc3339)
                            .ok()
                    }),
                    route: route.label.clone(),
                    update_id,
                    version: update.version.clone(),
                };
                *lock_pending(&manager).map_err(|error| command_error(OPERATION, error))? =
                    Some(PendingUpdate {
                        direct_download_url,
                        route: route.label,
                        update,
                        update_id,
                    });
                return Ok(Some(metadata));
            }
            Err(error) => {
                log::warn!(target: "fineshell::updater", "更新线路 {} 检查失败：{error}", route.label);
                last_error = Some(error.to_string());
            }
        }
    }

    Err(command_error(
        OPERATION,
        last_error.unwrap_or_else(|| "没有可用的更新线路".to_string()),
    ))
}

async fn download_update(
    update: &Update,
    on_event: &Channel<ApplicationUpdateDownloadEvent>,
) -> Result<Vec<u8>, tauri_plugin_updater::Error> {
    let mut first_chunk = true;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ =
                        on_event.send(ApplicationUpdateDownloadEvent::Started { content_length });
                }
                let _ = on_event.send(ApplicationUpdateDownloadEvent::Progress { chunk_length });
            },
            || {},
        )
        .await?;
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn application_update_download_and_install(
    manager: State<'_, ApplicationUpdateManager>,
    update_id: u64,
    on_event: Channel<ApplicationUpdateDownloadEvent>,
) -> CommandResult<()> {
    const OPERATION: &str = "application_update_download_and_install";
    let pending = {
        let mut guard = lock_pending(&manager).map_err(|error| command_error(OPERATION, error))?;
        match guard.take() {
            Some(pending) if pending.update_id == update_id => pending,
            Some(pending) => {
                *guard = Some(pending);
                return Err(command_error(OPERATION, "更新任务已失效，请重新检查更新"));
            }
            None => return Err(command_error(OPERATION, "没有可安装的更新")),
        }
    };

    let mut pending = pending;
    let first_result = download_update(&pending.update, &on_event).await;
    let bytes = match first_result {
        Ok(bytes) => bytes,
        Err(error) if pending.update.download_url != pending.direct_download_url => {
            log::warn!(target: "fineshell::updater", "镜像线路 {} 下载失败，回退 GitHub：{error}", pending.route);
            pending.update.download_url = pending.direct_download_url.clone();
            let _ = on_event.send(ApplicationUpdateDownloadEvent::Fallback {
                route: "GitHub 直连".to_string(),
            });
            match download_update(&pending.update, &on_event).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    *lock_pending(&manager)
                        .map_err(|state_error| command_error(OPERATION, state_error))? =
                        Some(pending);
                    return Err(command_error(OPERATION, error));
                }
            }
        }
        Err(error) => {
            *lock_pending(&manager)
                .map_err(|state_error| command_error(OPERATION, state_error))? = Some(pending);
            return Err(command_error(OPERATION, error));
        }
    };

    if let Err(error) = pending.update.install(bytes) {
        *lock_pending(&manager).map_err(|state_error| command_error(OPERATION, state_error))? =
            Some(pending);
        return Err(command_error(OPERATION, error));
    }
    let _ = on_event.send(ApplicationUpdateDownloadEvent::Finished);
    Ok(())
}

#[tauri::command]
pub(crate) fn application_update_close(
    manager: State<'_, ApplicationUpdateManager>,
    update_id: u64,
) -> CommandResult<()> {
    const OPERATION: &str = "application_update_close";
    let mut pending = lock_pending(&manager).map_err(|error| command_error(OPERATION, error))?;
    if pending
        .as_ref()
        .is_some_and(|update| update.update_id == update_id)
    {
        *pending = None;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn application_update_test_route(
    request: ApplicationUpdateRequest,
) -> CommandResult<ApplicationUpdateRouteTestResult> {
    const OPERATION: &str = "application_update_test_route";
    let routes = update_routes(&request).map_err(|error| command_error(OPERATION, error))?;
    let source = Url::parse(FINESHELL_LATEST_RELEASE_URL)
        .map_err(|error| command_error(OPERATION, error))?;
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .user_agent("FineShell updater route test")
        .build()
        .map_err(|error| command_error(OPERATION, error))?;
    let mut last_error = None;

    for route in routes {
        let endpoint =
            route_url(&route, &source).map_err(|error| command_error(OPERATION, error))?;
        let started = Instant::now();
        match client.get(endpoint).send().await {
            Ok(response) if response.status().is_success() => {
                let body = response
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|error| command_error(OPERATION, error))?;
                if body
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
                    || body
                        .get("platforms")
                        .and_then(serde_json::Value::as_object)
                        .is_none()
                {
                    last_error = Some(format!("{} 返回了无效的更新清单", route.label));
                    continue;
                }
                return Ok(ApplicationUpdateRouteTestResult {
                    latency_ms: started.elapsed().as_millis(),
                    route: route.label,
                });
            }
            Ok(response) => {
                last_error = Some(format!("{} 返回 HTTP {}", route.label, response.status()));
            }
            Err(error) => last_error = Some(format!("{}：{error}", route.label)),
        }
    }

    Err(command_error(
        OPERATION,
        last_error.unwrap_or_else(|| "没有可用的更新线路".to_string()),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        mirrored_url, normalized_mirror_prefix, update_routes, ApplicationUpdateRequest,
        BUILTIN_MIRRORS,
    };
    use tauri::Url;

    fn request(route: &str, custom_url: Option<&str>) -> ApplicationUpdateRequest {
        ApplicationUpdateRequest {
            route: route.to_string(),
            custom_url: custom_url.map(ToString::to_string),
        }
    }

    #[test]
    fn automatic_route_uses_builtins_then_github() {
        let routes = update_routes(&request("auto", None)).unwrap();
        assert_eq!(routes.len(), BUILTIN_MIRRORS.len() + 1);
        assert_eq!(routes[0].label, "gh-proxy.com");
        assert_eq!(routes[1].label, "ghproxy.net");
        assert_eq!(routes[2].label, "GitHub 直连");
    }

    #[test]
    fn selected_mirror_still_falls_back_to_github() {
        let routes = update_routes(&request("ghproxy.net", None)).unwrap();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].label, "ghproxy.net");
        assert_eq!(routes[1].label, "GitHub 直连");
    }

    #[test]
    fn custom_route_requires_https_and_is_normalized() {
        assert!(normalized_mirror_prefix("http://mirror.example.com").is_err());
        let prefix = normalized_mirror_prefix("https://mirror.example.com/github").unwrap();
        assert_eq!(prefix.as_str(), "https://mirror.example.com/github/");
    }

    #[test]
    fn mirror_prefix_wraps_the_complete_github_url() {
        let prefix = Url::parse("https://ghproxy.net/").unwrap();
        let source = Url::parse("https://github.com/owner/repo/releases/latest").unwrap();
        assert_eq!(
            mirrored_url(&prefix, &source).unwrap().as_str(),
            "https://ghproxy.net/https://github.com/owner/repo/releases/latest"
        );
    }
}
