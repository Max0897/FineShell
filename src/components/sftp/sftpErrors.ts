export function isSftpTransferCancellation(message: string) {
  return /传输已取消|连接已取消|cancel(?:led|ed)/i.test(message);
}

export function isSftpSessionFailure(message: string) {
  return /会话不存在|会话已停止|连接已关闭|connection|disconnect|socket/i.test(
    message,
  );
}
