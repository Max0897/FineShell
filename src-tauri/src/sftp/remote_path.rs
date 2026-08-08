use std::path::Path;

pub(super) fn remote_path_text(path: &Path) -> String {
    normalize_remote_separators(&path.to_string_lossy())
}

pub(super) fn normalize_remote_separators(path: &str) -> String {
    path.replace('\\', "/")
}

pub(super) fn normalize_remote_operation_path(path: &str) -> Result<String, String> {
    let path = normalize_remote_separators(path);
    if path.contains('\0') || !path.starts_with('/') {
        return Err("文件操作只允许使用有效的远程绝对路径".to_string());
    }

    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" => {}
            "." | ".." => return Err("文件操作路径不能包含相对路径片段".to_string()),
            value => segments.push(value),
        }
    }
    Ok(if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    })
}

pub(super) fn remote_join_path(base: &str, relative: &str) -> Result<String, String> {
    let mut result = normalize_remote_operation_path(base)?;
    let relative = normalize_remote_separators(relative);
    let mut appended = false;
    for segment in relative.split('/') {
        if segment.is_empty() || matches!(segment, "." | "..") || segment.contains('\0') {
            return Err("远程相对路径包含无效片段".to_string());
        }
        if result != "/" {
            result.push('/');
        }
        result.push_str(segment);
        appended = true;
    }
    appended
        .then_some(result)
        .ok_or_else(|| "远程相对路径不能为空".to_string())
}

pub(super) fn remote_file_name(path: &str) -> Option<String> {
    let path = normalize_remote_separators(path);
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

pub(super) fn remote_parent_path(path: &str) -> Option<String> {
    let normalized = normalize_remote_operation_path(path).ok()?;
    if normalized == "/" {
        return None;
    }
    let separator = normalized.rfind('/')?;
    Some(if separator == 0 {
        "/".to_string()
    } else {
        normalized[..separator].to_string()
    })
}

pub(super) fn remote_sibling_path(path: &str, file_name: &str) -> Result<String, String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains('\0')
        || matches!(file_name, "." | "..")
    {
        return Err("远程文件名称无效".to_string());
    }
    let parent = remote_parent_path(path).ok_or_else(|| "远程路径缺少父目录".to_string())?;
    remote_join_path(&parent, file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_separators_without_changing_remote_semantics() {
        assert_eq!(
            normalize_remote_operation_path(r"\srv\releases\report.txt").unwrap(),
            "/srv/releases/report.txt"
        );
        assert_eq!(
            remote_join_path(r"\srv\releases", r"daily\report.txt").unwrap(),
            "/srv/releases/daily/report.txt"
        );
    }

    #[test]
    fn creates_remote_siblings_with_posix_separators() {
        assert_eq!(
            remote_sibling_path(r"\srv\releases\report.txt", ".report.txt.part").unwrap(),
            "/srv/releases/.report.txt.part"
        );
    }

    #[test]
    fn rejects_relative_remote_paths_and_parent_traversal() {
        assert!(normalize_remote_operation_path(r"srv\report.txt").is_err());
        assert!(normalize_remote_operation_path(r"\srv\..\report.txt").is_err());
        assert!(remote_join_path("/srv", "../report.txt").is_err());
    }
}
