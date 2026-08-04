import { Button, Drawer, Tooltip } from "@arco-design/web-react";
import { IconDelete } from "@arco-design/web-react/icon";
import type { ExternalEditPayload } from "../../tauri-protocol";
import { isActiveSftpTransfer } from "../../sftp-utils";
import TransferActivityList, {
  type TransferActivityRecord,
} from "../TransferActivityList";

interface SftpTransferDrawerProps {
  externalEdits: ExternalEditPayload[];
  onCancelTransfer: (transfer: TransferActivityRecord) => void;
  onClearFinished: () => void;
  onClose: () => void;
  onOpenExternalEdit: (edit: ExternalEditPayload) => void;
  onPauseTransfer: (transfer: TransferActivityRecord) => void;
  onResolveExternalEdit: (edit: ExternalEditPayload) => void;
  onResumeTransfer: (transfer: TransferActivityRecord) => void;
  onRetryTransfer: (transfer: TransferActivityRecord) => void;
  transfers: TransferActivityRecord[];
  visible: boolean;
}

export default function SftpTransferDrawer({
  externalEdits,
  onCancelTransfer,
  onClearFinished,
  onClose,
  onOpenExternalEdit,
  onPauseTransfer,
  onResolveExternalEdit,
  onResumeTransfer,
  onRetryTransfer,
  transfers,
  visible,
}: SftpTransferDrawerProps) {
  return (
    <Drawer
      bodyStyle={{ padding: 0 }}
      className="sftp-transfer-drawer"
      footer={null}
      getChildrenPopupContainer={() => document.body}
      onCancel={onClose}
      title={
        <div className="sftp-transfer-drawer-title">
          <span>传输记录</span>
          {transfers.some((item) => !isActiveSftpTransfer(item.status)) && (
            <Tooltip content="清除已结束记录">
              <Button
                aria-label="清除已结束传输和同步记录"
                icon={<IconDelete />}
                onClick={onClearFinished}
                size="mini"
                type="text"
              />
            </Tooltip>
          )}
        </div>
      }
      visible={visible}
      width={440}
    >
      <TransferActivityList
        externalEdits={externalEdits}
        onCancel={onCancelTransfer}
        onOpenExternalEdit={onOpenExternalEdit}
        onPause={onPauseTransfer}
        onResolveExternalEdit={onResolveExternalEdit}
        onResume={onResumeTransfer}
        onRetry={onRetryTransfer}
        transfers={transfers}
      />
    </Drawer>
  );
}
