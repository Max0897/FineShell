import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Space, Tooltip } from "@arco-design/web-react";

interface AiApprovalActionsProps {
  approvalKey: string;
  approveDisabled?: boolean;
  approveTooltip?: ReactNode;
  busy?: boolean;
  buttonSize?: "mini" | "small" | "default" | "large";
  feedbackPlaceholder: string;
  leading?: ReactNode;
  onApprove: () => unknown | Promise<unknown>;
  onReject: () => unknown | Promise<unknown>;
  onRevise?: (feedback: string) => unknown | Promise<unknown>;
}

function AiApprovalActions({
  approvalKey,
  approveDisabled = false,
  approveTooltip,
  busy = false,
  buttonSize = "mini",
  feedbackPlaceholder,
  leading,
  onApprove,
  onReject,
  onRevise,
}: AiApprovalActionsProps) {
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const disabled = busy || processing;

  useEffect(() => {
    processingRef.current = false;
    setFeedback("");
    setProcessing(false);
    setRevising(false);
  }, [approvalKey]);

  const runDecision = async (decision: () => unknown | Promise<unknown>) => {
    if (processingRef.current || busy) return;
    processingRef.current = true;
    setProcessing(true);
    try {
      await decision();
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };

  const submitRevision = () => {
    const value = feedback.trim();
    if (!value || !onRevise) return;
    void runDecision(() => onRevise(value));
  };

  const approveButton = (
    <Button
      disabled={disabled || approveDisabled}
      loading={processing}
      onClick={() => void runDecision(onApprove)}
      size={buttonSize}
      type="primary"
    >
      同意
    </Button>
  );

  return (
    <div className="ai-approval-actions">
      {revising && (
        <div className="ai-approval-feedback">
          <Input
            autoFocus
            disabled={disabled}
            maxLength={1_000}
            onChange={setFeedback}
            onPressEnter={submitRevision}
            placeholder={feedbackPlaceholder}
            value={feedback}
          />
          <Button
            disabled={disabled || !feedback.trim()}
            loading={processing}
            onClick={submitRevision}
            size={buttonSize}
            type="primary"
          >
            提交
          </Button>
        </div>
      )}
      <div className="ai-approval-action-row">
        <div className="ai-approval-action-leading">{leading}</div>
        <Space size={4}>
          {revising ? (
            <Button
              disabled={disabled}
              onClick={() => {
                setFeedback("");
                setRevising(false);
              }}
              size={buttonSize}
              type="text"
            >
              取消
            </Button>
          ) : (
            <>
              {onRevise && (
                <Button
                  disabled={disabled}
                  onClick={() => setRevising(true)}
                  size={buttonSize}
                  type="text"
                >
                  其他
                </Button>
              )}
              <Button
                disabled={disabled}
                onClick={() => void runDecision(onReject)}
                size={buttonSize}
                type="text"
              >
                驳回
              </Button>
              {approveTooltip ? (
                <Tooltip content={approveTooltip}>{approveButton}</Tooltip>
              ) : (
                approveButton
              )}
            </>
          )}
        </Space>
      </div>
    </div>
  );
}

export default AiApprovalActions;
