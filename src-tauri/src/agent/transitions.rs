use super::*;

impl AgentTaskManager {
    pub(crate) fn transition_action(
        &self,
        request: AgentActionTransitionRequest,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if !valid_identifier(&request.task_id) || !valid_identifier(&request.action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let summary = bounded_action_message(request.summary)?;
        let error = bounded_action_message(request.error)?;
        let task_id = request.task_id;
        let events = {
            let mut tasks = self.lock_tasks()?;
            let task = tasks
                .get_mut(&task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if matches!(
                task.status,
                AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }
            let index = task
                .actions
                .iter()
                .position(|action| action.id == request.action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            let action_id = task.actions[index].id.clone();
            if task.status == AgentTaskStatus::Completed
                && !matches!(
                    request.transition,
                    AgentActionTransition::Retry | AgentActionTransition::RollbackStart
                )
            {
                return Err("AI 动作已经结束".to_string());
            }
            action_fingerprint(&task.actions[index].tool, &task.actions[index].arguments)?;
            let now = timestamp_ms();
            let mut events = Vec::with_capacity(3);
            match request.transition {
                AgentActionTransition::Approve => {
                    if task.actions[index].status != AgentActionStatus::Pending {
                        return Err("AI 动作当前不能批准".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Approved;
                    task.actions[index].summary = summary;
                    task.actions[index].error = None;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionApproved, &action_id));
                }
                AgentActionTransition::Reject => {
                    if !matches!(
                        task.actions[index].status,
                        AgentActionStatus::Pending | AgentActionStatus::Approved
                    ) {
                        return Err("AI 动作当前不能拒绝".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Rejected;
                    task.actions[index].summary =
                        summary.or_else(|| Some("用户拒绝了该动作".to_string()));
                    task.actions[index].error = None;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].verification_status =
                        AgentVerificationStatus::NotApplicable;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionRejected, &action_id));
                }
                AgentActionTransition::Start => {
                    if task.actions[index].status == AgentActionStatus::Pending {
                        task.actions[index].status = AgentActionStatus::Approved;
                        task.actions[index].summary = Some("用户批准了该动作".to_string());
                        task.refresh_action_status();
                        events.push(
                            task.action_event(AgentTaskEventKind::ActionApproved, &action_id),
                        );
                    }
                    if task.actions[index].status != AgentActionStatus::Approved {
                        return Err("AI 动作当前不能开始".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Running;
                    task.actions[index].summary = summary;
                    task.actions[index].error = None;
                    task.actions[index].started_at = Some(now);
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.actions[index].verification_status = AgentVerificationStatus::Pending;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionStarted, &action_id));
                }
                AgentActionTransition::Succeed => {
                    if task.actions[index].status != AgentActionStatus::Running {
                        return Err("AI 动作当前不能标记为成功".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Succeeded;
                    task.actions[index].summary =
                        summary.or_else(|| Some("动作已成功完成".to_string()));
                    task.actions[index].error = None;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Unverified;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionSucceeded, &action_id));
                }
                AgentActionTransition::Conflict => {
                    let (status, kind) = match task.actions[index].status {
                        AgentActionStatus::Running => (
                            AgentActionStatus::Conflict,
                            AgentTaskEventKind::ActionConflicted,
                        ),
                        AgentActionStatus::RollingBack => (
                            AgentActionStatus::RollbackConflict,
                            AgentTaskEventKind::ActionRollbackConflicted,
                        ),
                        _ => return Err("AI 动作当前不能标记为冲突".to_string()),
                    };
                    task.actions[index].status = status;
                    task.actions[index].error =
                        error.or_else(|| Some("远端状态发生冲突".to_string()));
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Failed;
                    if status == AgentActionStatus::RollbackConflict {
                        task.actions[index].update_recovery(
                            AgentRecoveryRecommendation::Rollback,
                            AgentRecoveryStatus::Failed,
                            "回滚时远端状态发生冲突，需要人工检查",
                            now,
                        );
                    } else {
                        let retry_available = task.repair_attempts < task.repair_limit;
                        task.actions[index].suggest_repair(retry_available, now);
                    }
                    task.refresh_action_status();
                    events.push(task.action_event(kind, &action_id));
                }
                AgentActionTransition::Fail => {
                    let (status, kind) = match task.actions[index].status {
                        AgentActionStatus::Approved | AgentActionStatus::Running => {
                            (AgentActionStatus::Failed, AgentTaskEventKind::ActionFailed)
                        }
                        AgentActionStatus::RollingBack => (
                            AgentActionStatus::RollbackFailed,
                            AgentTaskEventKind::ActionRollbackFailed,
                        ),
                        _ => return Err("AI 动作当前不能标记为失败".to_string()),
                    };
                    task.actions[index].status = status;
                    task.actions[index].error = error.or_else(|| Some("动作执行失败".to_string()));
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Failed;
                    if status == AgentActionStatus::RollbackFailed {
                        task.actions[index].update_recovery(
                            AgentRecoveryRecommendation::Rollback,
                            AgentRecoveryStatus::Failed,
                            "回滚执行失败，需要人工检查远端状态",
                            now,
                        );
                    } else {
                        let retry_available = task.repair_attempts < task.repair_limit;
                        task.actions[index].suggest_repair(retry_available, now);
                    }
                    task.refresh_action_status();
                    events.push(task.action_event(kind, &action_id));
                }
                AgentActionTransition::RollbackStart => {
                    if task.actions[index].status != AgentActionStatus::Succeeded {
                        return Err("AI 动作当前不能回滚".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::RollingBack;
                    task.actions[index].summary = summary;
                    task.actions[index].error = None;
                    task.actions[index].started_at = Some(now);
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.actions[index].verification_status = AgentVerificationStatus::Pending;
                    task.actions[index].update_recovery(
                        AgentRecoveryRecommendation::Rollback,
                        AgentRecoveryStatus::Running,
                        "正在回滚并等待恢复状态验证",
                        now,
                    );
                    task.result = None;
                    task.refresh_action_status();
                    events.push(
                        task.action_event(AgentTaskEventKind::ActionRollbackStarted, &action_id),
                    );
                }
                AgentActionTransition::RolledBack => {
                    if task.actions[index].status != AgentActionStatus::RollingBack {
                        return Err("AI 动作当前不能标记为已回滚".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::RolledBack;
                    task.actions[index].summary =
                        summary.or_else(|| Some("动作已安全回滚".to_string()));
                    task.actions[index].error = None;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Unverified;
                    task.actions[index].update_recovery(
                        AgentRecoveryRecommendation::Rollback,
                        AgentRecoveryStatus::Unverified,
                        "回滚动作已结束，但未取得可信的恢复状态证据",
                        now,
                    );
                    task.refresh_action_status();
                    events
                        .push(task.action_event(AgentTaskEventKind::ActionRolledBack, &action_id));
                }
                AgentActionTransition::Retry => {
                    let verification_failed = matches!(
                        task.actions[index].status,
                        AgentActionStatus::Succeeded | AgentActionStatus::RolledBack
                    ) && task.actions[index].verification_status
                        == AgentVerificationStatus::Failed;
                    if !verification_failed
                        && !matches!(
                            task.actions[index].status,
                            AgentActionStatus::Conflict
                                | AgentActionStatus::Failed
                                | AgentActionStatus::RollbackConflict
                                | AgentActionStatus::RollbackFailed
                        )
                    {
                        return Err("AI 动作当前不能重试".to_string());
                    }
                    if task.repair_attempts >= task.repair_limit {
                        task.repair_stop_reason =
                            Some(AgentRepairStopReason::RepairBudgetExhausted);
                        if let Some(result) = task.result.as_mut() {
                            result.stop_reason = Some("repair_budget_exhausted".to_string());
                        }
                        return Err("AI 任务修复次数已达到上限".to_string());
                    }
                    task.repair_attempts = task.repair_attempts.saturating_add(1);
                    task.repair_stop_reason = None;
                    task.actions[index].update_recovery(
                        AgentRecoveryRecommendation::Retry,
                        AgentRecoveryStatus::Running,
                        format!(
                            "正在执行第 {} 次修复，完成后将重新验证目标状态",
                            task.repair_attempts
                        ),
                        now,
                    );
                    task.actions[index].status = AgentActionStatus::Pending;
                    task.actions[index].summary = None;
                    task.actions[index].error = None;
                    task.actions[index].started_at = None;
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.actions[index].verification_status = AgentVerificationStatus::Pending;
                    task.actions[index].verification_evidence.clear();
                    task.actions[index].command_submission_id = None;
                    task.actions[index].command_execution = None;
                    task.result = None;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionRetried, &action_id));
                }
            }
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(&task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn observe_command_execution(
        &self,
        request: AgentCommandObservationRequest,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if [
            request.task_id.as_str(),
            request.action_id.as_str(),
            request.host_id.as_str(),
            request.session_id.as_str(),
            request.submission_id.as_str(),
        ]
        .into_iter()
        .any(|value| !valid_identifier(value))
            || !valid_command(&request.command)
        {
            return Err("终端命令观察范围无效".to_string());
        }
        if request
            .duration_ms
            .is_some_and(|duration| duration > MAX_OBSERVED_COMMAND_DURATION_MS)
            || request.exit_code.is_some_and(|exit_code| exit_code > 255)
        {
            return Err("终端命令观察结果无效".to_string());
        }
        let reason = bounded_action_message(request.reason)?;
        match request.phase {
            AgentCommandObservationPhase::Submitted
                if request.exit_code.is_some()
                    || request.duration_ms.is_some()
                    || reason.is_some() =>
            {
                return Err("终端命令提交事件包含无效结果".to_string());
            }
            AgentCommandObservationPhase::Completed
                if request.exit_code.is_none()
                    || request.duration_ms.is_none()
                    || reason.is_some() =>
            {
                return Err("终端命令完成事件缺少退出信息".to_string());
            }
            AgentCommandObservationPhase::Unavailable
                if request.exit_code.is_some()
                    || request.duration_ms.is_none()
                    || reason.is_none() =>
            {
                return Err("终端命令不可用事件缺少原因".to_string());
            }
            _ => {}
        }

        let task_id = request.task_id;
        let events = {
            let mut tasks = self.lock_tasks()?;
            let task = tasks
                .get_mut(&task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            let index = task
                .actions
                .iter()
                .position(|action| action.id == request.action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            if task.actions[index].tool != "execute_terminal_command" {
                return Err("AI 动作不是终端命令提案".to_string());
            }
            let trusted_command = task.actions[index]
                .arguments
                .get("command")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "AI 命令缺少可信参数".to_string())?;
            let business_verification = task.actions[index]
                .arguments
                .get("verification")
                .cloned()
                .map(AgentBusinessVerification::from_value)
                .transpose()?;
            if task.host_id != request.host_id
                || task.terminal_session_id.as_deref() != Some(request.session_id.as_str())
                || trusted_command != request.command.trim()
            {
                return Err("终端提交与 AI 命令提案不匹配".to_string());
            }
            let same_submission = task.actions[index].command_submission_id.as_deref()
                == Some(request.submission_id.as_str());
            if matches!(
                task.actions[index].status,
                AgentActionStatus::Succeeded | AgentActionStatus::Failed
            ) {
                if same_submission {
                    return Ok(Vec::new());
                }
                return Err("AI 命令已经由其他终端提交结束".to_string());
            }
            let action_id = task.actions[index].id.clone();
            let now = timestamp_ms();
            if task.status == AgentTaskStatus::Cancelled
                && request.phase == AgentCommandObservationPhase::Unavailable
                && same_submission
            {
                if let Some(command) = task.actions[index].command_execution.as_mut() {
                    command.phase = AgentCommandExecutionPhase::Interrupted;
                    command.reason = reason;
                    command.duration_ms = request.duration_ms;
                    command.updated_at = now;
                    command.completed_at = Some(now);
                }
                return Ok(vec![
                    task.action_event(AgentTaskEventKind::ActionProgress, &action_id)
                ]);
            }
            if matches!(
                task.status,
                AgentTaskStatus::Completed | AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }

            let mut events = Vec::with_capacity(3);
            match task.actions[index].status {
                AgentActionStatus::Approved => {
                    task.actions[index].command_submission_id = Some(request.submission_id.clone());
                    task.actions[index].command_execution = Some(AgentCommandExecutionState {
                        submission_id: request.submission_id.clone(),
                        phase: AgentCommandExecutionPhase::Connecting,
                        output_excerpt: None,
                        output_truncated: false,
                        stdout_excerpt: None,
                        stdout_truncated: false,
                        stderr_excerpt: None,
                        stderr_truncated: false,
                        exit_code: None,
                        duration_ms: None,
                        reason: None,
                        submitted_at: now,
                        updated_at: now,
                        completed_at: None,
                    });
                    task.actions[index].status = AgentActionStatus::Running;
                    task.actions[index].summary = Some("已提交后台 SSH 命令".to_string());
                    task.actions[index].error = None;
                    task.actions[index].started_at = Some(now);
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionStarted, &action_id));
                }
                AgentActionStatus::Running if same_submission => {
                    if request.phase == AgentCommandObservationPhase::Submitted {
                        return Ok(Vec::new());
                    }
                }
                AgentActionStatus::Running => {
                    return Err("AI 命令已经绑定其他终端提交".to_string());
                }
                _ => return Err("AI 命令当前不能接收执行结果".to_string()),
            }

            match request.phase {
                AgentCommandObservationPhase::Submitted => {}
                AgentCommandObservationPhase::Completed => {
                    let exit_code = request.exit_code.unwrap_or_default();
                    if let Some(command) = task.actions[index].command_execution.as_mut() {
                        command.phase = if exit_code == 0 {
                            AgentCommandExecutionPhase::Completed
                        } else {
                            AgentCommandExecutionPhase::Failed
                        };
                        command.exit_code = Some(exit_code);
                        command.duration_ms = request.duration_ms;
                        command.reason =
                            (exit_code != 0).then(|| format!("终端命令退出码 {exit_code}"));
                        command.updated_at = now;
                        command.completed_at = Some(now);
                    }
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = request.duration_ms;
                    if exit_code == 0 {
                        task.actions[index].status = AgentActionStatus::Succeeded;
                        task.actions[index].summary = Some("终端命令执行成功".to_string());
                        task.actions[index].error = None;
                        task.actions[index].record_verification(
                            if business_verification.is_some() {
                                AgentVerificationStatus::Pending
                            } else {
                                AgentVerificationStatus::Unverified
                            },
                            AgentVerificationEvidenceKind::CommandExitStatus,
                            if business_verification.is_some() {
                                "命令退出码为 0，等待业务目标验证"
                            } else {
                                "命令退出码为 0，仅确认命令进程正常结束"
                            },
                            now,
                        );
                        if business_verification.is_some() {
                            task.status = AgentTaskStatus::Verifying;
                        } else {
                            task.actions[index].finish_repair_verification(false, now);
                            task.refresh_action_status();
                        }
                        events.push(
                            task.action_event(AgentTaskEventKind::ActionSucceeded, &action_id),
                        );
                    } else {
                        task.actions[index].status = AgentActionStatus::Failed;
                        task.actions[index].summary = None;
                        task.actions[index].error = Some(format!("终端命令退出码 {exit_code}"));
                        task.actions[index].record_verification(
                            AgentVerificationStatus::Failed,
                            AgentVerificationEvidenceKind::CommandExitStatus,
                            format!("命令以退出码 {exit_code} 结束"),
                            now,
                        );
                        let retry_available = task.repair_attempts < task.repair_limit;
                        task.actions[index].suggest_repair(retry_available, now);
                        task.refresh_action_status();
                        events
                            .push(task.action_event(AgentTaskEventKind::ActionFailed, &action_id));
                    }
                    events.push(
                        task.action_event(
                            AgentTaskEventKind::ActionVerificationRecorded,
                            &action_id,
                        ),
                    );
                }
                AgentCommandObservationPhase::Unavailable => {
                    let execution_interrupted = reason.as_deref().is_some_and(|value| {
                        value.contains("超时")
                            || value.contains("连接已断开")
                            || value.contains("连接已关闭")
                    });
                    if let Some(command) = task.actions[index].command_execution.as_mut() {
                        command.phase = if execution_interrupted
                            || reason
                                .as_deref()
                                .is_some_and(|value| value.contains("取消"))
                        {
                            AgentCommandExecutionPhase::Interrupted
                        } else {
                            AgentCommandExecutionPhase::Failed
                        };
                        command.reason = reason.clone();
                        command.duration_ms = request.duration_ms;
                        command.updated_at = now;
                        command.completed_at = Some(now);
                    }
                    task.actions[index].status = AgentActionStatus::Failed;
                    task.actions[index].summary = None;
                    task.actions[index].error = reason.clone();
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = request.duration_ms;
                    task.actions[index].record_verification(
                        AgentVerificationStatus::Failed,
                        AgentVerificationEvidenceKind::ResultUnavailable,
                        "无法确认终端命令的结束状态",
                        now,
                    );
                    let retry_available = task.repair_attempts < task.repair_limit;
                    task.actions[index].suggest_repair(retry_available, now);
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionFailed, &action_id));
                    events.push(
                        task.action_event(
                            AgentTaskEventKind::ActionVerificationRecorded,
                            &action_id,
                        ),
                    );
                    if execution_interrupted {
                        task.status = AgentTaskStatus::Paused;
                        task.error = reason.clone();
                        events.push(task.event(AgentTaskEventKind::TaskPaused));
                    }
                }
            }
            if task.model_completed
                && !task.has_unresolved_actions()
                && task.status != AgentTaskStatus::Paused
            {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(&task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn observe_command_progress(
        &self,
        task_id: &str,
        action_id: &str,
        submission_id: &str,
        phase: AgentCommandExecutionPhase,
        output: AgentCommandOutputSnapshot,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if [task_id, action_id, submission_id]
            .into_iter()
            .any(|value| !valid_identifier(value))
            || phase.is_terminal()
        {
            return Err("AI 后台命令进度无效".to_string());
        }
        let mut tasks = self.lock_tasks()?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        let action = task
            .actions
            .iter_mut()
            .find(|action| action.id == action_id)
            .ok_or_else(|| "AI 动作不存在".to_string())?;
        if action.tool != "execute_terminal_command"
            || action.status != AgentActionStatus::Running
            || action.command_submission_id.as_deref() != Some(submission_id)
        {
            return Ok(Vec::new());
        }
        let command = action
            .command_execution
            .as_mut()
            .ok_or_else(|| "AI 后台命令缺少运行快照".to_string())?;
        command.phase = phase;
        command.updated_at = timestamp_ms();
        if let Some(excerpt) = output.output_excerpt {
            command.output_excerpt = Some(excerpt);
            command.output_truncated = output.output_truncated;
        }
        if let Some(stdout) = output.stdout_excerpt {
            command.stdout_excerpt = Some(stdout);
            command.stdout_truncated = output.stdout_truncated;
        }
        if let Some(stderr) = output.stderr_excerpt {
            command.stderr_excerpt = Some(stderr);
            command.stderr_truncated = output.stderr_truncated;
        }
        Ok(vec![task.action_event(
            AgentTaskEventKind::ActionProgress,
            action_id,
        )])
    }

    pub(crate) fn pending_business_verification(
        &self,
        task_id: &str,
        action_id: &str,
    ) -> Result<Option<PendingBusinessVerification>, String> {
        let tasks = self.lock_tasks()?;
        let Some(task) = tasks.get(task_id) else {
            return Err("AI 任务不存在".to_string());
        };
        let Some(action) = task.actions.iter().find(|action| action.id == action_id) else {
            return Err("AI 动作不存在".to_string());
        };
        if action.status != AgentActionStatus::Succeeded
            || action.verification_status != AgentVerificationStatus::Pending
        {
            return Ok(None);
        }
        let verification = action
            .arguments
            .get("verification")
            .cloned()
            .map(AgentBusinessVerification::from_value)
            .transpose()?;
        Ok(
            verification.map(|verification| PendingBusinessVerification {
                task_id: task_id.to_string(),
                action_id: action_id.to_string(),
                session_id: task.terminal_session_id.clone().unwrap_or_default(),
                verification,
            }),
        )
    }

    pub(crate) fn complete_business_verification(
        &self,
        pending: &PendingBusinessVerification,
        result: Result<AgentBusinessVerificationResult, String>,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let task_id = pending.task_id.clone();
        let events = {
            let mut tasks = self.lock_tasks()?;
            let task = tasks
                .get_mut(&task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            let index = task
                .actions
                .iter()
                .position(|action| action.id == pending.action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            if task.actions[index].status != AgentActionStatus::Succeeded
                || task.actions[index].verification_status != AgentVerificationStatus::Pending
            {
                return Ok(Vec::new());
            }
            let now = timestamp_ms();
            let (status, kind, summary) = match result {
                Ok(result) => (
                    if result.passed {
                        AgentVerificationStatus::Verified
                    } else {
                        AgentVerificationStatus::Failed
                    },
                    match pending.verification.kind() {
                        AgentBusinessVerificationKind::ServiceStatus => {
                            AgentVerificationEvidenceKind::ServiceStatus
                        }
                        AgentBusinessVerificationKind::PortListening => {
                            AgentVerificationEvidenceKind::PortListening
                        }
                        AgentBusinessVerificationKind::ConfigSyntax => {
                            AgentVerificationEvidenceKind::ConfigSyntax
                        }
                    },
                    result.summary,
                ),
                Err(_) => (
                    AgentVerificationStatus::Failed,
                    AgentVerificationEvidenceKind::ResultUnavailable,
                    "无法取得业务验证结果".to_string(),
                ),
            };
            task.actions[index].record_verification(status, kind, summary, now);
            if status == AgentVerificationStatus::Verified {
                task.actions[index].finish_repair_verification(true, now);
            } else {
                let retry_available = task.repair_attempts < task.repair_limit;
                task.actions[index].suggest_repair(retry_available, now);
            }
            task.refresh_action_status();
            let action_id = pending.action_id.clone();
            let mut events =
                vec![task.action_event(AgentTaskEventKind::ActionVerificationRecorded, &action_id)];
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(&task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn complete_trusted_action_execution(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        verification: AgentTrustedVerification,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if !valid_identifier(task_id) || !valid_identifier(action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let events = {
            let mut tasks = self.lock_tasks()?;
            let task = tasks
                .get_mut(task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if matches!(
                task.status,
                AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }
            let index = task
                .actions
                .iter()
                .position(|action| action.id == action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            let expected_status = if rollback {
                AgentActionStatus::RollingBack
            } else {
                AgentActionStatus::Running
            };
            if task.actions[index].status != expected_status {
                return Err("AI 动作当前不能记录可信执行结果".to_string());
            }
            if !matches!(
                (task.actions[index].tool.as_str(), verification),
                (
                    "propose_file_edit",
                    AgentTrustedVerification::RemoteContentMatch
                ) | ("propose_file_operation", _)
            ) {
                return Err("AI 动作与可信验证结果不匹配".to_string());
            }
            action_fingerprint(&task.actions[index].tool, &task.actions[index].arguments)?;

            let now = timestamp_ms();
            let (status, event_kind, summary, evidence_kind, evidence_summary) = if rollback {
                (
                    AgentActionStatus::RolledBack,
                    AgentTaskEventKind::ActionRolledBack,
                    "动作已安全回滚",
                    AgentVerificationEvidenceKind::RecoveryStateMatch,
                    "远端恢复状态与回滚目标一致",
                )
            } else {
                let (evidence_kind, evidence_summary) = match verification {
                    AgentTrustedVerification::RemoteContentMatch => (
                        AgentVerificationEvidenceKind::RemoteContentMatch,
                        "远端文件内容与本次写入结果一致",
                    ),
                    AgentTrustedVerification::RemotePathState => (
                        AgentVerificationEvidenceKind::RemotePathState,
                        "远端路径状态与本次文件操作结果一致",
                    ),
                };
                (
                    AgentActionStatus::Succeeded,
                    AgentTaskEventKind::ActionSucceeded,
                    "动作已成功完成",
                    evidence_kind,
                    evidence_summary,
                )
            };
            task.actions[index].status = status;
            task.actions[index].summary = Some(summary.to_string());
            task.actions[index].error = None;
            task.actions[index].completed_at = Some(now);
            task.actions[index].duration_ms = task.actions[index]
                .started_at
                .map(|started_at| now.saturating_sub(started_at));
            task.actions[index].record_verification(
                AgentVerificationStatus::Verified,
                evidence_kind,
                evidence_summary,
                now,
            );
            if rollback {
                task.actions[index].update_recovery(
                    AgentRecoveryRecommendation::Rollback,
                    AgentRecoveryStatus::Verified,
                    "远端恢复状态与回滚目标一致",
                    now,
                );
            } else {
                task.actions[index].finish_repair_verification(true, now);
            }
            task.refresh_action_status();
            let mut events = vec![
                task.action_event(event_kind, action_id),
                task.action_event(AgentTaskEventKind::ActionVerificationRecorded, action_id),
            ];
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(task_id)?;
        }
        Ok(events)
    }
}
