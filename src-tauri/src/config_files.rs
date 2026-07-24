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

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use super::{read_config_file, write_config_file, MAX_CONFIG_FILE_BYTES};

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fineshell-config-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn command_boundary_writes_and_reads_nested_configuration() {
        let directory = temporary_directory("round-trip");
        let path = directory.join("nested/config.json");
        let path_value = path.to_string_lossy().into_owned();

        write_config_file(path_value.clone(), "{\"version\":1}".to_string()).unwrap();
        assert_eq!(read_config_file(path_value).unwrap(), "{\"version\":1}");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn command_boundary_returns_structured_not_found_errors() {
        let path = temporary_directory("missing").join("config.json");
        let error = read_config_file(path.to_string_lossy().into_owned()).unwrap_err();
        let serialized = serde_json::to_value(error).unwrap();

        assert_eq!(serialized["code"], "not_found");
        assert_eq!(serialized["operation"], "read_config_file");
        assert_eq!(serialized["retryable"], false);
        assert!(serialized["message"]
            .as_str()
            .unwrap()
            .contains("无法读取配置文件"));
    }

    #[test]
    fn command_boundary_rejects_oversized_configuration_before_writing() {
        let path = temporary_directory("oversized").join("config.json");
        let error = write_config_file(
            path.to_string_lossy().into_owned(),
            "x".repeat(MAX_CONFIG_FILE_BYTES as usize + 1),
        )
        .unwrap_err();
        let serialized = serde_json::to_value(error).unwrap();

        assert_eq!(serialized["code"], "invalid_request");
        assert!(!path.exists());
    }
}
