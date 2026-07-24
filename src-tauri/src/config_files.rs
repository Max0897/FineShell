use std::{fs, path::Path};

use crate::protocol::{CommandError, CommandResult};

const MAX_CONFIG_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
pub fn read_config_file(path: String) -> CommandResult<String> {
    read_config_file_inner(path)
        .map_err(|error| CommandError::from_message("read_config_file", error))
}

fn read_config_file_inner(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取配置文件: {error}"))?;
    if metadata.len() > MAX_CONFIG_FILE_BYTES {
        return Err("配置文件超过 5 MB 限制".to_string());
    }

    fs::read_to_string(path).map_err(|error| format!("无法读取配置文件: {error}"))
}

#[tauri::command]
pub fn write_config_file(path: String, contents: String) -> CommandResult<()> {
    write_config_file_inner(path, contents)
        .map_err(|error| CommandError::from_message("write_config_file", error))
}

fn write_config_file_inner(path: String, contents: String) -> Result<(), String> {
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
