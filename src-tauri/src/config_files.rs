use std::{fs, path::Path};

const MAX_CONFIG_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
pub fn read_config_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取配置文件: {error}"))?;
    if metadata.len() > MAX_CONFIG_FILE_BYTES {
        return Err("配置文件超过 5 MB 限制".to_string());
    }

    fs::read_to_string(path).map_err(|error| format!("无法读取配置文件: {error}"))
}

#[tauri::command]
pub fn write_config_file(path: String, contents: String) -> Result<(), String> {
    if contents.len() as u64 > MAX_CONFIG_FILE_BYTES {
        return Err("配置文件超过 5 MB 限制".to_string());
    }
    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录: {error}"))?;
        }
    }

    fs::write(path, contents).map_err(|error| format!("无法写入配置文件: {error}"))
}
