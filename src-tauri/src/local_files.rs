use std::path::{Path, PathBuf};

use crate::protocol::{CommandError, CommandResult};

const LOCAL_FILE_MISSING: &str = "本地文件不存在，可能已被移动或删除";

fn existing_local_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("本地文件路径不能为空".to_string());
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("本地文件路径无效".to_string());
    }
    if !path.exists() {
        return Err(LOCAL_FILE_MISSING.to_string());
    }
    Ok(path.to_path_buf())
}

/// Opens the system file manager at the file's directory with the file selected.
#[tauri::command]
pub(crate) fn local_file_reveal(path: String) -> CommandResult<()> {
    existing_local_path(&path)
        .and_then(|path| {
            tauri_plugin_opener::reveal_item_in_dir(path)
                .map_err(|error| format!("无法打开本地文件所在位置：{error}"))
        })
        .map_err(|error| CommandError::from_message("local_file_reveal", error))
}

/// Opens the file with the system's default application.
#[tauri::command]
pub(crate) fn local_file_open(path: String) -> CommandResult<()> {
    existing_local_path(&path)
        .and_then(|path| {
            tauri_plugin_opener::open_path(path, None::<&str>)
                .map_err(|error| format!("无法打开本地文件：{error}"))
        })
        .map_err(|error| CommandError::from_message("local_file_open", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_relative_and_missing_paths() {
        assert!(existing_local_path("").is_err());
        assert!(existing_local_path("relative/file.txt").is_err());
        let missing = std::env::temp_dir().join("fineshell-missing-local-file-for-test");
        assert_eq!(
            existing_local_path(missing.to_str().unwrap()),
            Err(LOCAL_FILE_MISSING.to_string())
        );
    }

    #[test]
    fn classifies_missing_files_as_not_found() {
        let error = CommandError::from_message("local_file_reveal", LOCAL_FILE_MISSING);
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "not_found");
    }

    #[test]
    fn accepts_existing_files() {
        let directory = std::env::temp_dir();
        assert_eq!(
            existing_local_path(directory.to_str().unwrap()),
            Ok(directory)
        );
    }
}
