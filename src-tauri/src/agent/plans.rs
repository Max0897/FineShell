use super::*;

impl AgentTaskManager {
    pub(crate) fn set_plan(
        &self,
        task_id: &str,
        mut plan: AgentPlan,
        approval_requirements: HashMap<String, String>,
    ) -> Result<(watch::Receiver<AgentPlanDecision>, Vec<AgentTaskEvent>), String> {
        if approval_requirements.len() > plan.steps.len()
            || approval_requirements
                .keys()
                .any(|call_id| !plan.steps.iter().any(|step| step.id == *call_id))
            || approval_requirements
                .values()
                .any(|fingerprint| fingerprint.is_empty())
        {
            return Err("AI 计划审批范围无效".to_string());
        }
        let awaiting_approval = !approval_requirements.is_empty();
        let initial_decision = if awaiting_approval {
            AgentPlanDecision::Pending
        } else {
            AgentPlanDecision::Approve(AgentPlanApproval {
                selected_call_ids: plan.steps.iter().map(|step| step.id.clone()).collect(),
                credentials: Vec::new(),
            })
        };
        plan.status = AgentPlanStatus::Pending;
        let (sender, receiver) = watch::channel(initial_decision);
        self.revoke_task_approvals(task_id)?;
        let mut tasks = self.lock_tasks()?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        if task.status.is_terminal() {
            return Err("AI 任务已经结束".to_string());
        }
        task.status = if awaiting_approval {
            AgentTaskStatus::AwaitingApproval
        } else {
            AgentTaskStatus::Running
        };
        task.plan = Some(plan.clone());
        self.plan_controls
            .lock()
            .map_err(|_| "AI 计划控制状态不可用".to_string())?
            .insert(
                task_id.to_string(),
                AgentPlanControl {
                    plan_id: plan.id.clone(),
                    approval_requirements,
                    sender,
                },
            );
        Ok((receiver, vec![task.event(AgentTaskEventKind::PlanCreated)]))
    }

    pub(crate) fn update_plan(
        &self,
        task_id: &str,
        plan: AgentPlan,
        completed: bool,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let mut tasks = self.lock_tasks()?;
        let Some(task) = tasks.get_mut(task_id) else {
            return Ok(Vec::new());
        };
        if task.status.is_terminal() {
            return Ok(Vec::new());
        }
        task.status = AgentTaskStatus::Running;
        task.active_step_id = if completed {
            None
        } else {
            plan.steps
                .iter()
                .find(|step| step.status == AgentPlanStepStatus::InProgress)
                .map(|step| step.id.clone())
        };
        task.plan = Some(plan);
        Ok(vec![task.event(if completed {
            AgentTaskEventKind::PlanCompleted
        } else {
            AgentTaskEventKind::PlanUpdated
        })])
    }

    pub(crate) fn start_plan(
        &self,
        task_id: &str,
        mut plan: AgentPlan,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let mut tasks = self.lock_tasks()?;
        let Some(task) = tasks.get_mut(task_id) else {
            return Ok(Vec::new());
        };
        if task.status.is_terminal() {
            return Ok(Vec::new());
        }
        plan.status = AgentPlanStatus::Running;
        task.status = AgentTaskStatus::Running;
        task.active_step_id = None;
        task.plan = Some(plan);
        Ok(vec![task.event(AgentTaskEventKind::PlanStarted)])
    }

    pub(crate) fn clear_plan_control(&self, task_id: &str) {
        let plan_id = self
            .plan_controls
            .lock()
            .ok()
            .and_then(|mut controls| controls.remove(task_id).map(|control| control.plan_id));
        if let Some(plan_id) = plan_id {
            if let Ok(mut credentials) = self.approval_credentials.lock() {
                credentials.revoke_plan(task_id, &plan_id);
            }
        }
    }

    pub(crate) fn consume_approval(
        &self,
        credential: &ApprovalCredential,
        expected_scope: ApprovalScope,
    ) -> Result<(), String> {
        self.approval_credentials
            .lock()
            .map_err(|_| "AI 审批凭证状态不可用".to_string())?
            .consume(credential, &expected_scope, timestamp_ms())
    }

    pub(super) fn revoke_task_approvals(&self, task_id: &str) -> Result<(), String> {
        self.approval_credentials
            .lock()
            .map_err(|_| "AI 审批凭证状态不可用".to_string())?
            .revoke_task(task_id);
        Ok(())
    }

    pub(super) fn decide_plan(&self, request: AgentPlanDecisionRequest) -> Result<(), String> {
        if !valid_identifier(&request.task_id) || !valid_identifier(&request.plan_id) {
            return Err("AI 计划标识无效".to_string());
        }
        let selected_call_ids = request
            .selected_call_ids
            .into_iter()
            .map(|value| value.trim().to_string())
            .collect::<Vec<_>>();
        if selected_call_ids.len() > 6
            || selected_call_ids
                .iter()
                .any(|value| !valid_identifier(value))
            || selected_call_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != selected_call_ids.len()
        {
            return Err("AI 计划选择无效".to_string());
        }
        let feedback = request
            .feedback
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if feedback
            .as_ref()
            .is_some_and(|value| value.chars().count() > 1_000)
        {
            return Err("AI 审批反馈过长".to_string());
        }
        if feedback.is_some() && !matches!(request.decision, AgentPlanDecisionKind::Reject) {
            return Err("AI 审批反馈只能用于拒绝决定".to_string());
        }
        let (host_id, session_id, current_directory) = {
            let tasks = self.lock_tasks()?;
            let task = tasks
                .get(&request.task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            let plan = task
                .plan
                .as_ref()
                .filter(|plan| plan.id == request.plan_id)
                .ok_or_else(|| "AI 计划不存在".to_string())?;
            if selected_call_ids
                .iter()
                .any(|call_id| !plan.steps.iter().any(|step| step.id == *call_id))
            {
                return Err("AI 计划选择不属于当前计划".to_string());
            }
            (
                task.host_id.clone(),
                task.terminal_session_id.clone(),
                task.current_directory.clone(),
            )
        };
        let controls = self
            .plan_controls
            .lock()
            .map_err(|_| "AI 计划控制状态不可用".to_string())?;
        let control = controls
            .get(&request.task_id)
            .filter(|control| control.plan_id == request.plan_id)
            .ok_or_else(|| "AI 计划已经结束".to_string())?;
        let decision = match request.decision {
            AgentPlanDecisionKind::Approve => {
                if *control.sender.borrow() != AgentPlanDecision::Pending {
                    return Err("AI 计划已经作出决定".to_string());
                }
                let mut credentials = self
                    .approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?;
                credentials.revoke_plan(&request.task_id, &request.plan_id);
                let issued = selected_call_ids
                    .iter()
                    .filter_map(|call_id| {
                        control
                            .approval_requirements
                            .get(call_id)
                            .map(|fingerprint| (call_id, fingerprint))
                    })
                    .map(|(call_id, action_fingerprint)| {
                        credentials.issue(
                            ApprovalScope {
                                task_id: request.task_id.clone(),
                                plan_id: request.plan_id.clone(),
                                call_id: call_id.clone(),
                                host_id: host_id.clone(),
                                session_id: session_id.clone(),
                                current_directory: current_directory.clone(),
                                action_fingerprint: action_fingerprint.clone(),
                            },
                            timestamp_ms(),
                            APPROVAL_CREDENTIAL_TTL_MS,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>();
                let issued = match issued {
                    Ok(issued) => issued,
                    Err(error) => {
                        credentials.revoke_plan(&request.task_id, &request.plan_id);
                        return Err(error);
                    }
                };
                AgentPlanDecision::Approve(AgentPlanApproval {
                    selected_call_ids,
                    credentials: issued,
                })
            }
            AgentPlanDecisionKind::Reject => {
                if *control.sender.borrow() != AgentPlanDecision::Pending {
                    return Err("AI 计划已经作出决定".to_string());
                }
                self.approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                    .revoke_plan(&request.task_id, &request.plan_id);
                AgentPlanDecision::Reject(feedback)
            }
            AgentPlanDecisionKind::Stop => {
                self.approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                    .revoke_plan(&request.task_id, &request.plan_id);
                AgentPlanDecision::Stop
            }
        };
        let result = control
            .sender
            .send(decision)
            .map_err(|_| "AI 计划已经结束".to_string());
        if result.is_err() {
            self.approval_credentials
                .lock()
                .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                .revoke_plan(&request.task_id, &request.plan_id);
        }
        result
    }
}
