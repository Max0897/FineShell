use super::*;

impl AgentTaskContext {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn terminal_session_id(&self) -> Option<&str> {
        self.terminal_session_id.as_deref()
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.host_id
    }

    pub(crate) fn approval_mode(&self) -> AgentApprovalMode {
        self.approval_mode
    }

    pub(crate) fn current_directory(&self) -> Option<&str> {
        self.current_directory.as_deref()
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        let now = timestamp_ms();
        if self.context_version != AGENT_CONTEXT_VERSION {
            return Err("AI 任务上下文版本不受支持，请重新发起任务".to_string());
        }
        if self.context_captured_at > now.saturating_add(MAX_AGENT_CONTEXT_CLOCK_SKEW_MS)
            || now.saturating_sub(self.context_captured_at) > MAX_AGENT_CONTEXT_AGE_MS
        {
            return Err("AI 任务上下文已过期，请重新发起任务".to_string());
        }
        if !valid_identifier(&self.id)
            || !valid_identifier(&self.conversation_id)
            || !valid_identifier(&self.host_id)
            || self
                .terminal_session_id
                .as_deref()
                .is_some_and(|value| !valid_identifier(value))
            || self.current_directory.as_deref().is_some_and(|value| {
                value.trim().is_empty()
                    || !value.starts_with('/')
                    || value.chars().count() > 1_024
                    || value.chars().any(char::is_control)
            })
            || self
                .file_operation_directory
                .as_deref()
                .is_some_and(|value| {
                    normalize_remote_action_path(value).as_deref() != Ok(value)
                        || self.current_directory.as_deref() != Some(value)
                })
        {
            return Err("AI 任务作用域无效".to_string());
        }
        if self.writable_files.len() > MAX_AGENT_WRITABLE_FILES {
            return Err("AI 任务可写文件数量超过限制".to_string());
        }
        let mut paths = std::collections::HashSet::new();
        let mut total_bytes = 0_usize;
        for file in &self.writable_files {
            let content_bytes = file.content.len();
            if normalize_remote_action_path(&file.path).as_deref() != Ok(file.path.as_str())
                || !paths.insert(file.path.as_str())
                || content_bytes > MAX_AGENT_WRITABLE_FILE_BYTES
                || file.content.contains('\0')
                || u64::try_from(content_bytes).ok() != Some(file.size)
            {
                return Err("AI 任务可写文件快照无效".to_string());
            }
            total_bytes = total_bytes.saturating_add(content_bytes);
        }
        if total_bytes > MAX_AGENT_WRITABLE_FILES_BYTES {
            return Err("AI 任务可写文件总大小超过限制".to_string());
        }
        let objective = self.objective.trim();
        if objective.is_empty() || objective.chars().count() > MAX_AGENT_OBJECTIVE_CHARS {
            return Err("AI 任务目标无效".to_string());
        }
        Ok(())
    }

    pub(super) fn matches(&self, task: &AgentTask) -> bool {
        self.context_version == task.context_version
            && self.id == task.id
            && self.conversation_id == task.conversation_id
            && self.host_id == task.host_id
            && self.terminal_session_id == task.terminal_session_id
            && self.current_directory == task.current_directory
            && self.file_operation_directory == task.file_operation_directory
            && self.writable_files == task.writable_files
            && self.approval_mode == task.approval_mode
            && self.objective.trim() == task.objective
    }
}

impl AgentTask {
    pub(super) fn from_context(context: &AgentTaskContext) -> Self {
        let now = timestamp_ms();
        Self {
            context_version: context.context_version,
            context_captured_at: context.context_captured_at,
            id: context.id.clone(),
            conversation_id: context.conversation_id.clone(),
            host_id: context.host_id.clone(),
            terminal_session_id: context.terminal_session_id.clone(),
            current_directory: context.current_directory.clone(),
            file_operation_directory: context.file_operation_directory.clone(),
            writable_files: context.writable_files.clone(),
            approval_mode: context.approval_mode,
            status: AgentTaskStatus::Understanding,
            objective: context.objective.trim().to_string(),
            plan: None,
            active_step_id: None,
            actions: Vec::new(),
            model_completed: false,
            iteration: 0,
            repair_attempts: 0,
            repair_limit: MAX_AGENT_REPAIR_ATTEMPTS,
            repair_stop_reason: None,
            diagnostics: AgentTaskDiagnostics::default(),
            last_event_sequence: 0,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub(super) fn refresh_context(&mut self, context: &AgentTaskContext) {
        self.context_captured_at = context.context_captured_at;
    }

    pub(super) fn validate_execution_context(&self) -> Result<&str, String> {
        if self.context_version != AGENT_CONTEXT_VERSION {
            return Err("AI 任务上下文版本不受支持，请重新发起任务".to_string());
        }
        if timestamp_ms().saturating_sub(self.context_captured_at) > MAX_AGENT_CONTEXT_AGE_MS {
            return Err("AI 任务上下文已过期，请重新发起分析".to_string());
        }
        self.terminal_session_id
            .as_deref()
            .ok_or_else(|| "AI 动作缺少绑定会话".to_string())
    }

    pub(super) fn redacted_for_persistence(&self) -> Self {
        let mut task = self.clone();
        task.objective = "任务内容已脱敏".to_string();
        task.current_directory = None;
        task.file_operation_directory = None;
        task.writable_files.clear();
        task.error = task
            .error
            .as_ref()
            .map(|_| "任务包含未公开的错误详情".to_string());
        if let Some(plan) = task.plan.as_mut() {
            plan.description = None;
            for step in &mut plan.steps {
                step.title = "已脱敏的计划步骤".to_string();
                step.detail = None;
                step.reason = "计划原因已脱敏".to_string();
                step.summary = step.summary.as_ref().map(|_| "计划步骤已结束".to_string());
                step.error = step.error.as_ref().map(|_| "计划步骤未成功".to_string());
            }
        }
        for action in &mut task.actions {
            action.reason = match action.tool.as_str() {
                "propose_file_edit" => "远程文件修改".to_string(),
                "propose_file_operation" => "远程文件操作".to_string(),
                "execute_terminal_command" => "终端命令".to_string(),
                _ => "受控动作".to_string(),
            };
            action.expected_effect = "动作效果已脱敏".to_string();
            action.summary = action
                .summary
                .as_ref()
                .map(|_| "动作状态已更新".to_string());
            action.error = action.error.as_ref().map(|_| "动作未成功".to_string());
            action.arguments = serde_json::Value::Null;
            action.command_submission_id = None;
            if let Some(command) = action.command_execution.as_mut() {
                command.output_excerpt = None;
                command.output_truncated = false;
                command.stdout_excerpt = None;
                command.stdout_truncated = false;
                command.stderr_excerpt = None;
                command.stderr_truncated = false;
            }
            for evidence in &mut action.verification_evidence {
                evidence.summary = "验证证据已脱敏".to_string();
            }
            if let Some(recovery) = action.recovery_state.as_mut() {
                recovery.summary = "恢复状态已记录".to_string();
            }
        }
        if let Some(result) = task.result.as_mut() {
            result.summary = "任务结果已记录".to_string();
        }
        task
    }

    pub(super) fn event(&mut self, kind: AgentTaskEventKind) -> AgentTaskEvent {
        self.event_for_action(kind, None)
    }

    pub(super) fn action_event(
        &mut self,
        kind: AgentTaskEventKind,
        action_id: &str,
    ) -> AgentTaskEvent {
        self.event_for_action(kind, Some(action_id.to_string()))
    }

    pub(super) fn event_for_action(
        &mut self,
        kind: AgentTaskEventKind,
        action_id: Option<String>,
    ) -> AgentTaskEvent {
        self.last_event_sequence = self.last_event_sequence.saturating_add(1);
        self.updated_at = timestamp_ms();
        self.refresh_diagnostics();
        AgentTaskEvent {
            protocol_version: PROTOCOL_VERSION,
            sequence: self.last_event_sequence,
            kind,
            action_id,
            task: self.clone(),
        }
    }

    pub(super) fn refresh_diagnostics(&mut self) {
        self.diagnostics = AgentTaskDiagnostics {
            duration_ms: self.updated_at.saturating_sub(self.created_at),
            model_turn_count: self.iteration,
            plan_step_count: self.plan.as_ref().map_or(0, |plan| plan.steps.len()),
            action_count: self.actions.len(),
            verification_evidence_count: self
                .actions
                .iter()
                .map(|action| action.verification_evidence.len())
                .sum(),
            repair_attempt_count: self.repair_attempts,
            stop_reason: self
                .repair_stop_reason
                .map(|reason| match reason {
                    AgentRepairStopReason::VerificationFailed => "verification_failed",
                    AgentRepairStopReason::ActionFailed => "action_failed",
                    AgentRepairStopReason::RepairBudgetExhausted => "repair_budget_exhausted",
                })
                .map(str::to_string),
        };
    }

    pub(super) fn has_unresolved_actions(&self) -> bool {
        self.actions.iter().any(|action| {
            action.status.is_unresolved()
                || (matches!(
                    action.status,
                    AgentActionStatus::Succeeded | AgentActionStatus::RolledBack
                ) && action.verification_status == AgentVerificationStatus::Pending)
        })
    }

    pub(super) fn refresh_action_status(&mut self) {
        self.status = if self
            .actions
            .iter()
            .any(|action| action.status == AgentActionStatus::Pending)
        {
            AgentTaskStatus::AwaitingApproval
        } else {
            AgentTaskStatus::Running
        };
    }

    pub(super) fn complete_actions(&mut self) {
        let has_failure = self.actions.iter().any(|action| {
            matches!(
                action.status,
                AgentActionStatus::Conflict
                    | AgentActionStatus::Failed
                    | AgentActionStatus::RollbackConflict
                    | AgentActionStatus::RollbackFailed
                    | AgentActionStatus::Cancelled
            )
        });
        let has_verification_failure = self
            .actions
            .iter()
            .any(|action| action.verification_status == AgentVerificationStatus::Failed);
        let (applicable_actions, verified_actions) =
            self.actions
                .iter()
                .fold((0_usize, 0_usize), |(applicable, verified), action| {
                    if action.verification_status == AgentVerificationStatus::NotApplicable {
                        (applicable, verified)
                    } else {
                        (
                            applicable + 1,
                            verified
                                + usize::from(
                                    action.verification_status == AgentVerificationStatus::Verified,
                                ),
                        )
                    }
                });
        let verification_status = if applicable_actions == 0 {
            AgentVerificationStatus::NotApplicable
        } else if (has_failure || has_verification_failure) && verified_actions == 0 {
            AgentVerificationStatus::Failed
        } else if verified_actions == applicable_actions {
            AgentVerificationStatus::Verified
        } else if verified_actions > 0 {
            AgentVerificationStatus::Partial
        } else {
            AgentVerificationStatus::Unverified
        };
        self.repair_stop_reason = if has_verification_failure {
            Some(if self.repair_attempts >= self.repair_limit {
                AgentRepairStopReason::RepairBudgetExhausted
            } else {
                AgentRepairStopReason::VerificationFailed
            })
        } else if has_failure {
            Some(if self.repair_attempts >= self.repair_limit {
                AgentRepairStopReason::RepairBudgetExhausted
            } else {
                AgentRepairStopReason::ActionFailed
            })
        } else {
            None
        };
        self.status = AgentTaskStatus::Completed;
        self.result = Some(AgentTaskResult {
            summary: if has_failure {
                "AI 任务已结束，部分动作未成功完成".to_string()
            } else if has_verification_failure {
                "AI 任务已完成执行，但业务验证未通过".to_string()
            } else if verification_status == AgentVerificationStatus::Unverified {
                "AI 任务已完成，但尚无充分验证证据".to_string()
            } else if verification_status == AgentVerificationStatus::Partial {
                "AI 任务已完成，部分结果已经验证".to_string()
            } else {
                "AI 任务已完成".to_string()
            },
            verified: verification_status == AgentVerificationStatus::Verified,
            verification_status,
            stop_reason: self
                .repair_stop_reason
                .map(|reason| match reason {
                    AgentRepairStopReason::VerificationFailed => "verification_failed",
                    AgentRepairStopReason::ActionFailed => "action_failed",
                    AgentRepairStopReason::RepairBudgetExhausted => "repair_budget_exhausted",
                })
                .map(str::to_string),
        });
    }

    pub(super) fn trusted_execution_arguments(
        &self,
        intent: &AgentActionIntent,
    ) -> Result<serde_json::Value, String> {
        let arguments = intent
            .arguments
            .as_object()
            .ok_or_else(|| "AI 动作参数无效".to_string())?;
        match intent.tool.as_str() {
            "propose_file_edit" => {
                let path = arguments
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件修改路径无效".to_string())?;
                let content = arguments
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件修改内容无效".to_string())?;
                let original = self
                    .writable_files
                    .iter()
                    .find(|file| file.path == path)
                    .ok_or_else(|| "AI 文件修改不在本次可写边界中".to_string())?;
                if original.content == content {
                    return Err("AI 文件修改没有产生变化".to_string());
                }
                Ok(serde_json::json!({
                    "content": content,
                    "originalContent": original.content,
                    "path": path,
                }))
            }
            "propose_file_operation" => {
                let operation = arguments
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件操作类型无效".to_string())?;
                let path = arguments
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件操作路径无效".to_string())?;
                match operation {
                    "create" => {
                        if self.file_operation_directory.as_deref()
                            != Some(remote_parent_path(path))
                        {
                            return Err("AI 新建文件不在本次可写目录中".to_string());
                        }
                        Ok(intent.arguments.clone())
                    }
                    "rename" | "delete" => {
                        let original = self
                            .writable_files
                            .iter()
                            .find(|file| file.path == path)
                            .ok_or_else(|| "AI 文件操作不在本次可写边界中".to_string())?;
                        if operation == "rename" {
                            let target_path = arguments
                                .get("targetPath")
                                .and_then(serde_json::Value::as_str)
                                .ok_or_else(|| "AI 重命名目标路径无效".to_string())?;
                            if remote_parent_path(target_path) != remote_parent_path(path) {
                                return Err("AI 重命名目标必须与源文件位于同一目录".to_string());
                            }
                        }
                        let mut trusted = arguments.clone();
                        trusted.insert(
                            "expectedContent".to_string(),
                            serde_json::Value::String(original.content.clone()),
                        );
                        Ok(serde_json::Value::Object(trusted))
                    }
                    _ => Err("AI 文件操作类型无效".to_string()),
                }
            }
            "execute_terminal_command" => {
                if self.terminal_session_id.is_none() {
                    return Err("AI 终端命令缺少绑定会话".to_string());
                }
                Ok(intent.arguments.clone())
            }
            _ => Err("AI 动作不在可信执行注册表中".to_string()),
        }
    }
}
