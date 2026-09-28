export function isSftpTransferCancellation(message: string) {
  return /传输已取消|连接已取消|cancel(?:led|ed)/i.test(message);
}

export function isSftpSessionFailure(message: string) {
  return /会话不存在|会话已停止|连接已关闭|connection|disconnect|socket/i.test(
    message,
  );
}

export function isSftpUploadRetryableError(message: string) {
  if (
    /需要确认覆盖|同名目录|当前仅支持上传文件|无法打开本地文件|读取本地文件失败|权限|permission denied|access denied|拒绝访问/i.test(
      message,
    )
  ) {
    return false;
  }
  return /connection|disconnect|socket|timeout|超时|无进度|网络|远程|上传|写入/i.test(
    message,
  );
}
