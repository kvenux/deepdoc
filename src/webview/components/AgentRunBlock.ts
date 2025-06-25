// --- file_path: webview/components/AgentRunBlock.ts ---

import { AgentPlan, AgentResult, StepExecution, StepUpdate, StreamChunk, AgentPlanStep, StepResult } from '../../common/types';
import { marked } from 'marked';
import { vscode } from '../vscode';

type AgentStatus = 'planning' | 'validating' | 'executing' | 'completed' | 'failed' | 'cancelled';

interface ExecutionStepState extends StepExecution {
    logs: { type: 'input' | 'output' | 'llm-request', data: any, metadata?: Record<string, any> }[];
    isCollapsed: boolean;
    streamedContent: string;
    error?: string;
}

export class AgentRunBlock {
    private element: HTMLElement;
    private plan: AgentPlan;
    private onExecute: (params: Record<string, any>) => void;
    private status: AgentStatus = 'planning';
    private executionState: Map<string, ExecutionStepState> = new Map();
    private agentResult: AgentResult | null = null;
    private animatedStepIds: Set<string> = new Set();
    private stepElementsCache: Map<string, HTMLElement> = new Map(); // <-- 新增：缓存步骤 DOM 元素

    constructor(
        container: HTMLElement,
        plan: AgentPlan,
        onExecute: (params: Record<string, any>) => void
    ) {
        this.element = container;
        this.plan = plan;
        this.onExecute = onExecute;
        this.element.className = 'agent-run-block';

        this.render();
        this.setupEventListeners();
    }

    public updateStep(step: StepExecution | StepResult) {
        console.log('[AgentRunBlock] updateStep called with:', step); // <--- ADD THIS
        // console.log('[AgentRunBlock] current executionState before update:', new Map(this.executionState)); // <--- ADD THIS
        let existing = this.executionState.get(step.taskId || step.stepName);
        if (existing) {
            existing.status = step.status;
            if (step.status === 'failed' && 'error' in step) {
                existing.error = (step as any).error;
            }
        } else {
            const newStepState: ExecutionStepState = { ...step, logs: [], isCollapsed: false, streamedContent: '' };
            if (step.status === 'failed' && 'error' in step) {
                newStepState.error = (step as any).error;
            }
            existing = newStepState;
        }
        this.executionState.set(step.taskId || step.stepName, existing);
        this.render();
    }

    public addStepLog(update: StepUpdate) {
        // Use the stepName from the plan if taskId is not present, or a global key for logs not tied to a specific step/task.
        const stepKey = update.taskId ||
            (this.plan.steps.find(s => s.name === update.metadata?.stepNameHint)?.name) || // Heuristic if backend can provide a hint
            'global_logs'; // Fallback for truly global logs not tied to a task

        const stepState = this.executionState.get(stepKey) || Array.from(this.executionState.values()).find(s => s.stepName === stepKey);

        if (stepState && (update.type === 'input' || update.type === 'output' || update.type === 'llm-request')) {
            stepState.logs.push({ type: update.type, data: update.data, metadata: update.metadata });
            this.render();
        }
    }

    public appendStreamChunk(chunk: StreamChunk) {
        // 优先使用 taskId。
        // 后端 Executor 在发送 StreamChunk 时应该总是包含 taskId。
        const stepKey = chunk.taskId;

        if (!stepKey) {
            // 如果 taskId 真的缺失了，这是一个潜在的问题，需要排查后端逻辑。
            // 暂时打印警告并忽略这个数据块，以避免运行时错误和不正确的状态更新。
            console.warn('AgentRunBlock: StreamChunk received without taskId. This might indicate an issue in the backend. Chunk:', chunk);
            return;
        }

        const stepState = this.executionState.get(stepKey);

        if (stepState) {
            stepState.streamedContent += chunk.content;
            this.render(); // 重新渲染以显示更新的流式内容
        } else {
            // 如果根据 taskId 找不到对应的 stepState，这也是一个潜在问题。
            // 可能 updateStep 还没有为这个 taskId 创建状态，或者 taskId 错误。
            console.warn(`AgentRunBlock: Could not find step state for taskId '${stepKey}' to append stream chunk. Known taskIds:`, Array.from(this.executionState.keys()), "Chunk:", chunk);
        }
    }

    public setAgentResult(result: AgentResult) {
        this.status = result.status;
        this.agentResult = result;
        this.render();
    }

    // --- 渲染逻辑 ---

    private render() {
        const isPlanningReadOnly = this.status !== 'planning' && this.status !== 'validating';

        // --- 规划视图 ---
        const planningViewContainer = this.element.querySelector('.planning-view-container');
        if (!planningViewContainer) { // 首次渲染或从执行视图切回
            this.element.innerHTML = `<div class="planning-view-container"></div><div class="executing-view-container"></div>`;
        }
        const planningContainer = this.element.querySelector('.planning-view-container') as HTMLElement;
        planningContainer.innerHTML = this.renderPlanningView(isPlanningReadOnly);


        // --- 执行视图 ---
        const executingViewContainer = this.element.querySelector('.executing-view-container') as HTMLElement;

        if (isPlanningReadOnly) {
            if (!executingViewContainer.classList.contains('active')) { // 首次进入执行视图
                this.animatedStepIds.clear(); // 重置动画状态
                this.stepElementsCache.clear(); // 清空缓存的 DOM 元素
                executingViewContainer.classList.add('active');
            }
            this.renderExecutingViewContents(executingViewContainer);
        } else {
            executingViewContainer.classList.remove('active');
            executingViewContainer.innerHTML = ''; // 清空执行视图内容
        }

        this.postRender();
    }

    private renderPlanningView(isReadOnly: boolean): string {
        // ... (此方法内容保持不变，只是它现在渲染到 planningContainer) ...
        const badgeClass = this.status === 'planning' || this.status === 'validating' ? 'planning' : 'completed';
        const badgeText = this.status === 'planning' || this.status === 'validating' ? '待执行' : '规划已锁定';

        return `
            <div class="planning-view ${isReadOnly ? 'read-only' : ''}">
                <div class="agent-header">
                    <h4>${this.plan.agentName}</h4>
                    <span class="badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="agent-plan-steps">
                    <h5>执行计划</h5>
                    ${this.plan.steps.map(step => this.renderStepCard(step)).join('')}
                </div>
                ${this.plan.parameters.length > 0 ? `
                    <div class="agent-parameters">
                        <h5>参数</h5>
                        ${this.plan.parameters.map(param => this.renderParameterInput(param, isReadOnly)).join('')}
                    </div>
                ` : ''}
                <div class="agent-actions" style="display: ${isReadOnly ? 'none' : 'flex'};">
                    <button class="execute-btn">开始执行</button>
                    <button class="cancel-btn secondary">取消</button>
                </div>
            </div>
        `;
    }

    // 新方法：渲染执行视图的整体框架和内容
    private renderExecutingViewContents(container: HTMLElement) {
        const statusClassMapping: Record<AgentStatus, string> = {
            planning: 'planning',
            validating: 'planning',
            executing: 'executing',
            completed: 'completed',
            failed: 'failed',
            cancelled: 'failed'
        };
        const statusClass = statusClassMapping[this.status] || 'executing';
        const statusText = this.status.charAt(0).toUpperCase() + this.status.slice(1);

        let executionStepsOuterContainer = container.querySelector('.execution-steps-outer-container') as HTMLElement;
        if (!executionStepsOuterContainer) {
            container.innerHTML = `
            <div class="executing-view">
                <div class="agent-header">
                    <h4>执行过程</h4>
                    <span class="badge ${statusClass}">${statusText}</span>
                </div>
                <div class="execution-steps-outer-container">
                    <!-- 步骤将在这里被选择性更新或创建 -->
                </div>
                <div class="final-result-container">
                    <!-- 最终结果将在这里被选择性更新或创建 -->
                </div>
            </div>
        `;
            executionStepsOuterContainer = container.querySelector('.execution-steps-outer-container') as HTMLElement;
        } else {
            const badge = container.querySelector('.executing-view .agent-header .badge') as HTMLElement;
            if (badge) {
                badge.className = `badge ${statusClass}`;
                badge.textContent = statusText;
            }
        }

        // 渲染或更新每个步骤
        this.plan.steps.forEach((planStep, index) => {
            const executionStepState = Array.from(this.executionState.values())
                .find(s => s.stepName === planStep.name);

            console.log(`[AgentRunBlock] Rendering plan step: "${planStep.name}". Found state:`, executionStepState); // <--- ADD THIS
            if (!executionStepState && planStep.name === "分析: 并行处理模块") {
                console.warn("[AgentRunBlock] State for '分析: 并行处理模块' not found!"); // <--- ADD THIS
            }

            if (!executionStepState) { // 如果此计划步骤还没有对应的执行状态，则不渲染
                // 确保如果之前渲染过，现在被移除了
                const existingEl = this.stepElementsCache.get(planStep.name);
                if (existingEl) {
                    existingEl.remove();
                    this.stepElementsCache.delete(planStep.name);
                }
                return;
            }

            const stepMapKey = executionStepState.taskId || executionStepState.stepName;
            let stepElement = this.stepElementsCache.get(stepMapKey);

            if (!stepElement) { // 元素不存在，创建它
                let animationClass = '';
                if (!this.animatedStepIds.has(stepMapKey)) {
                    animationClass = 'needs-animation';
                    this.animatedStepIds.add(stepMapKey);
                }

                const stepHtml = planStep.name === "分析: 并行处理模块"
                    ? this.getParallelAnalysisStepHtml(planStep, index, executionStepState, animationClass)
                    : this.getExecutionStepHtml(executionStepState, planStep, index, animationClass);

                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = stepHtml.trim();
                stepElement = tempDiv.firstChild as HTMLElement;

                if (stepElement) {
                    executionStepsOuterContainer.appendChild(stepElement);
                    this.stepElementsCache.set(stepMapKey, stepElement);
                }
            } else { // 元素已存在，更新它
                this.updateStepElement(stepElement, executionStepState, planStep, planStep.name === "分析: 并行处理模块", index);
            }
        });

        // 渲染或更新最终结果
        const finalResultContainer = container.querySelector('.final-result-container') as HTMLElement;
        if (this.agentResult) {
            this.renderOrUpdateFinalResult(finalResultContainer);
        } else {
            finalResultContainer.innerHTML = ''; // 清空
        }
    }

    // 获取单个执行步骤的 HTML 字符串 (用于初次创建)
    private getExecutionStepHtml(stepState: ExecutionStepState, planStep: { name: string }, index: number, animationClass: string): string {
        const state = stepState.status;
        const isCollapsed = stepState.isCollapsed;
        const taskIdAttr = stepState.taskId ? `data-task-id="${stepState.taskId}"` : '';

        return `
            <div class="execution-step ${state} ${animationClass}" data-step-name="${planStep.name}" ${taskIdAttr}>
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content-wrapper">
                    ${this.renderStepInternals(stepState)}
                </div>
            </div>
        `;
    }

    // 获取并行分析步骤的 HTML 字符串 (用于初次创建)
    private getParallelAnalysisStepHtml(planStep: AgentPlanStep, index: number, parentStepState: ExecutionStepState, animationClass: string): string {
        const state = parentStepState.status;
        const taskIdAttr = parentStepState.taskId ? `data-task-id="${parentStepState.taskId}"` : '';
        // 注意：子步骤的初始渲染也在这里处理，因为它们是父步骤HTML的一部分
        const subStepsHtml = this.renderSubStepsContainer(parentStepState);

        return `
            <div class="execution-step ${state} ${animationClass}" data-step-name="${planStep.name}" ${taskIdAttr}>
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content-wrapper">
                     <div class="sub-steps-container">
                        ${subStepsHtml}
                    </div>
                </div>
            </div>
        `;
    }

    // 更新已存在的步骤元素
    private updateStepElement(element: HTMLElement, stepState: ExecutionStepState, planStep: AgentPlanStep, isParallel: boolean, index: number) {
        // 更新状态相关的类和图标
        element.className = `execution-step ${stepState.status}`; // 移除旧的 animation 类
        const statusIconEl = element.querySelector('.status-icon');
        if (statusIconEl) statusIconEl.innerHTML = this.getIconForStatus(stepState.status);
        const stepStatusEl = element.querySelector('.step-status');
        if (stepStatusEl) stepStatusEl.textContent = stepState.status;

        // 更新折叠状态
        const contentWrapper = element.querySelector('.step-content-wrapper') as HTMLElement;
        if (contentWrapper) {
            // 直接设置 max-height 可能会被 CSS transition 覆盖，
            // 最好是通过添加/移除类来控制，或者确保 style 设置在 CSS 之后。
            // 为了简单，我们暂时直接设置 style，但 CSS 中 transition 也应对应 .step-content-wrapper
            contentWrapper.style.maxHeight = stepState.isCollapsed ? '0' : (isParallel ? '5000px' : '2000px');
            contentWrapper.style.padding = stepState.isCollapsed ? '0 15px' : '10px 15px';


            if (isParallel) {
                const subStepsContainer = contentWrapper.querySelector('.sub-steps-container') as HTMLElement;
                if (subStepsContainer) {
                    subStepsContainer.innerHTML = this.renderSubStepsContainer(stepState);
                }
            } else {
                contentWrapper.innerHTML = this.renderStepInternals(stepState);
            }
        }
    }

    // 渲染子步骤容器的内容
    private renderSubStepsContainer(parentStepState: ExecutionStepState): string {
        const subSteps = Array.from(this.executionState.values()).filter(s =>
            s.stepName.startsWith("分析模块:") && s.runId === parentStepState.runId
        );
        console.log('[ARB] Filtered subSteps:', subSteps.map(s => ({ name: s.stepName, taskId: s.taskId, status: s.status })));


        if (subSteps.length > 0) {
            return subSteps.map(sub => {
                const subStepMapKey = sub.taskId || sub.stepName;
                let subAnimationClass = '';
                if (!this.animatedStepIds.has(subStepMapKey)) {
                    subAnimationClass = 'needs-animation';
                    this.animatedStepIds.add(subStepMapKey);
                }
                return this.getSubStepHtml(sub, subAnimationClass); // 获取HTML字符串
            }).join('');
        } else if (parentStepState.status === 'running') {
            return '<div class="sub-step-placeholder">等待模块分析任务启动...</div>';
        }
        return '';
    }

    // 获取单个子步骤的 HTML (用于初次创建或完整重绘子步骤列表)
    private getSubStepHtml(subStep: ExecutionStepState, animationClass: string): string {
        const isSubStepCollapsed = subStep.isCollapsed ?? true;
        return `
            <div class="sub-step ${subStep.status} ${animationClass}" data-task-id="${subStep.taskId}">
                 <div class="sub-step-header">
                    <span class="status-icon">${this.getIconForStatus(subStep.status)}</span>
                    <span class="step-name">${subStep.stepName}</span>
                </div>
                <div class="sub-step-content-wrapper">
                    ${this.renderStepInternals(subStep)}
                </div>
            </div>
        `;
    }

    // 选择性地渲染或更新最终结果
    private renderOrUpdateFinalResult(container: HTMLElement) {
        if (!this.agentResult) {
            container.innerHTML = '';
            this.stepElementsCache.delete('__agent_final_result__');
            return;
        }

        let resultElement = this.stepElementsCache.get('__agent_final_result__');
        const resultKey = '__agent_final_result__';
        let animationClass = '';

        if (!resultElement) {
            if (!this.animatedStepIds.has(resultKey)) {
                animationClass = 'needs-animation';
                this.animatedStepIds.add(resultKey);
            }
            const resultHtml = this.getFinalResultHtml(animationClass); // 方法来获取 HTML 字符串
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = resultHtml.trim();
            resultElement = tempDiv.firstChild as HTMLElement;
            if (resultElement) {
                container.innerHTML = ''; // 清空旧的（如果有）
                container.appendChild(resultElement);
                this.stepElementsCache.set(resultKey, resultElement);
            }
        } else {
            // 更新已存在的结果元素
            resultElement.className = `agent-final-result ${this.agentResult.status} ${animationClass}`; // animationClass 可能为空
            const iconEl = resultElement.querySelector('.result-header .codicon') as HTMLElement;
            const titleEl = resultElement.querySelector('.result-header span') as HTMLElement;
            const contentEl = resultElement.querySelector('.result-content') as HTMLElement;

            const isCompleted = this.agentResult.status === 'completed';
            if (iconEl) iconEl.className = `codicon ${isCompleted ? 'codicon-check-all' : 'codicon-error'}`;
            if (titleEl) titleEl.textContent = isCompleted ? 'Agent Execution Completed' : 'Agent Execution Failed';

            if (contentEl) {
                if (isCompleted) {
                    const output = this.agentResult.finalOutput;
                    if (typeof output === 'string' && (output.endsWith('.md') || output.endsWith('.txt') || output.includes('/'))) {
                        const fileName = output.includes('/') ? output.substring(output.lastIndexOf('/') + 1) : output;
                        contentEl.innerHTML = this.renderFileCard(output, fileName);
                    } else {
                        contentEl.innerHTML = `<p>${typeof output === 'string' ? output : JSON.stringify(output)}</p>`;
                    }
                } else {
                    contentEl.innerHTML = `<div class="error-text">${this.agentResult.error}</div>`;
                }
            }
        }
    }

    // 获取最终结果的 HTML (用于初次创建)
    private getFinalResultHtml(animationClass: string): string {
        if (!this.agentResult) return '';

        const resultClass = this.agentResult.status;
        const icon = resultClass === 'completed' ? '<i class="codicon codicon-check-all"></i>' : '<i class="codicon codicon-error"></i>';
        const title = resultClass === 'completed' ? 'Agent Execution Completed' : 'Agent Execution Failed';
        let contentHtml = '';

        if (resultClass === 'completed' && this.agentResult.stats) {
            // highlight-start
            // 如果执行成功并且有统计数据，则渲染统计信息
            const stats = this.agentResult.stats;
            contentHtml = `
                <div class="result-stats">
                    <div class="stat-item">
                        <i class="codicon codicon-clock"></i>
                        <span>耗时</span>
                        <strong>${stats.duration}</strong>
                    </div>
                    <div class="stat-item">
                        <i class="codicon codicon-symbol-event"></i>
                        <span>总 Tokens</span>
                        <strong>${stats.totalTokens.toLocaleString()}</strong>
                    </div>
                    <div class="stat-item">
                        <i class="codicon codicon-arrow-right"></i>
                        <span>输入 Tokens</span>
                        <strong>${stats.promptTokens.toLocaleString()}</strong>
                    </div>
                    <div class="stat-item">
                        <i class="codicon codicon-arrow-left"></i>
                        <span>输出 Tokens</span>
                        <strong>${stats.completionTokens.toLocaleString()}</strong>
                    </div>
                </div>
            `;
            // highlight-end
        } else if (resultClass !== 'completed') {
            // 对于失败状态，依然显示错误信息
            contentHtml = `<div class="error-text">${this.agentResult.error || '未知错误'}</div>`;
        }

        return `<div class="agent-final-result ${resultClass} ${animationClass}"><div class="result-header">${icon}<span>${title}</span></div><div class="result-content">${contentHtml}</div></div>`;
    }


    private renderExecutingView(): string {
        const statusClassMapping: Record<AgentStatus, string> = {
            planning: 'planning', validating: 'planning', executing: 'executing',
            completed: 'completed', failed: 'failed', cancelled: 'failed'
        };
        const statusClass = statusClassMapping[this.status] || 'executing';
        const statusText = this.status.charAt(0).toUpperCase() + this.status.slice(1);

        return `
            <div class="executing-view">
                <div class="agent-header">
                    <h4>执行过程</h4>
                    <span class="badge ${statusClass}">${statusText}</span>
                </div>
                <div class="execution-steps-container">
                    ${this.plan.steps.map((planStep, index) => {
            // Find the state for the main plan step
            const executionStepState = Array.from(this.executionState.values())
                .find(s => s.stepName === planStep.name);

            if (!executionStepState) {
                return '';
            }

            // Determine animation class for the main step
            const mainStepMapKey = executionStepState.taskId || executionStepState.stepName;
            let animationClass = '';
            if (!this.animatedStepIds.has(mainStepMapKey)) {
                animationClass = 'needs-animation';
                this.animatedStepIds.add(mainStepMapKey);
            }

            if (planStep.name === "分析: 并行处理模块") {
                return this.renderParallelAnalysisStep(planStep, index, executionStepState, animationClass);
            } else {
                return this.renderExecutionStep(executionStepState, planStep, index, animationClass);
            }
        }).join('')}
                </div>
                ${this.agentResult ? this.renderFinalResult() : ''}
            </div>
        `;
    }

    private renderStepCard(step: AgentPlanStep): string {
        return `
            <div class="step-card">
                <div class="step-card-name">${step.name}</div>
                <div class="step-card-desc">${step.description}</div>
                ${step.promptFiles && step.promptFiles.length > 0 ? `
                    <div class="prompt-files-container">
                        ${step.promptFiles.map(file => this.renderFileCard(file)).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    private renderParameterInput(param: { name: string, description: string, type: string, value?: any, isValid?: boolean, error?: string }, isReadOnly: boolean): string {
        const isInvalid = param.error ? 'invalid' : '';
        const value = param.value || '';
        return `
            <div class="parameter-item">
                <label for="param-${param.name}">${param.name}</label>
                <input type="text" id="param-${param.name}" name="${param.name}" placeholder="${param.description}" class="${isInvalid}" value="${value}" ${isReadOnly ? 'disabled' : ''}>
                ${param.error ? `<div class="error-text">${param.error}</div>` : ''}
            </div>
        `;
    }

    private renderStepInternals(stepState: ExecutionStepState): string {
        const logItemsHtml = stepState.logs.map(log => this.renderLogItem(log)).join('');

        let waitingPlaceholderHtml = '';
        const hasLlmRequest = stepState.logs.some(log => log.type === 'llm-request');
        const hasLlmResponse = !!stepState.streamedContent || stepState.logs.some(log => log.type === 'output');

        if (hasLlmRequest && !hasLlmResponse && stepState.status === 'running') { // Only show if running
            waitingPlaceholderHtml = `
                <div class="log-item llm-waiting-placeholder">
                    <div class="log-header">
                        <i class="codicon codicon-sync codicon-spin"></i>
                        <span>等待 LLM 响应<span class="loading-dots"></span></span>
                    </div>
                </div>
            `;
        }

        const streamHtml = stepState.streamedContent ? this.renderStreamedContent(stepState.streamedContent) : '';
        const errorHtml = stepState.error ? `<div class="step-error">${stepState.error}</div>` : '';

        return logItemsHtml + waitingPlaceholderHtml + streamHtml + errorHtml;
    }

    private renderExecutionStep(stepState: ExecutionStepState, planStep: { name: string }, index: number, animationClass: string): string {
        const state = stepState.status;
        const isCollapsed = stepState.isCollapsed;
        const taskIdAttr = stepState.taskId ? `data-task-id="${stepState.taskId}"` : '';

        return `
            <div class="execution-step ${state} ${animationClass}" data-step-name="${planStep.name}" ${taskIdAttr}>
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content" style="max-height: ${isCollapsed ? '0' : '2000px'};">
                    ${this.renderStepInternals(stepState)}
                </div>
            </div>
        `;
    }

    private renderParallelAnalysisStep(planStep: AgentPlanStep, index: number, parentStepState: ExecutionStepState, animationClass: string): string {
        const state = parentStepState.status;
        const isCollapsed = parentStepState.isCollapsed;
        // Get sub-steps related to this parent step's runId
        const subSteps = Array.from(this.executionState.values()).filter(s =>
            s.stepName.startsWith("分析模块:") && s.runId === parentStepState.runId
        );
        const taskIdAttr = parentStepState.taskId ? `data-task-id="${parentStepState.taskId}"` : '';

        return `
            <div class="execution-step ${state} ${animationClass}" data-step-name="${planStep.name}" ${taskIdAttr}>
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content" style="max-height: ${isCollapsed ? '0' : '5000px'};">
                    <div class="sub-steps-container">
                        ${subSteps.length > 0
                ? subSteps.map(sub => {
                    const subStepMapKey = sub.taskId || sub.stepName; // taskId should be present for sub-steps
                    let subAnimationClass = '';
                    if (!this.animatedStepIds.has(subStepMapKey)) {
                        subAnimationClass = 'needs-animation';
                        this.animatedStepIds.add(subStepMapKey);
                    }
                    return this.renderSubStep(sub, subAnimationClass);
                }).join('')
                : (parentStepState.status === 'running' ? '<div class="sub-step-placeholder">等待模块分析任务启动...</div>' : '')}
                    </div>
                </div>
            </div>
        `;
    }

    private renderSubStep(subStep: ExecutionStepState, animationClass: string): string {
        const isSubStepCollapsed = subStep.isCollapsed ?? true;
        return `
            <div class="sub-step ${subStep.status} ${animationClass}" data-task-id="${subStep.taskId}">
                 <div class="sub-step-header">
                    <span class="status-icon">${this.getIconForStatus(subStep.status)}</span>
                    <span class="step-name">${subStep.stepName}</span>
                </div>
                <div class="sub-step-content" style="max-height: ${isSubStepCollapsed ? '0' : '1000px'};">
                    ${this.renderStepInternals(subStep)}
                </div>
            </div>
        `;
    }

    private renderFileCard(filePath: string, displayName?: string): string {
        const fileName = displayName || filePath.split(/[\\/]/).pop() || 'file';
        let icon = 'codicon-file';
        if (fileName.endsWith('.md')) icon = 'codicon-markdown';
        if (fileName.endsWith('.json')) icon = 'codicon-json';
        if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) icon = 'codicon-symbol-keyword';
        if (fileName.endsWith('.txt')) icon = 'codicon-file-code';
        return `<div class="file-card" data-file-path="${filePath}" title="${filePath}"><i class="codicon ${icon}"></i><span>${fileName}</span></div>`;
    }

    private getIconForLogType(logType: string): string {
        switch (logType) {
            case 'input': return '<i class="codicon codicon-arrow-right"></i>';
            case 'output': return '<i class="codicon codicon-arrow-left"></i>';
            case 'llm-request': return '<i class="codicon codicon-comment"></i>';
            case 'llm-stream': return '<i class="codicon codicon-wand"></i>';
            default: return '';
        }
    }

    private renderLogItem(log: { type: string, data: any, metadata?: Record<string, any> }): string {
        let content = '';
        const logDataName = log.data && typeof log.data === 'object' && 'name' in log.data ? log.data.name : '';

        // 提取 log content 用于判断长度
        const logContent = log.data && typeof log.data === 'object' && 'content' in log.data
            ? (typeof log.data.content === 'string' ? log.data.content : JSON.stringify(log.data.content, null, 2))
            : (typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2));

        if (log.metadata?.type === 'file') {
            content = this.renderFileCard(log.metadata.path, logDataName);
        } else {
            // 使用已经提取的 logContent
            content = `<pre><code>${logContent}</code></pre>`;
        }

        const iconHtml = this.getIconForLogType(log.type);
        const titleText = `${log.type.toUpperCase()}${logDataName ? ': ' + logDataName : ''}`;

        // 启发式判断：如果是一个 input 类型的日志，并且内容很长（比如超过500字符且包含换行），
        // 就默认给它添加 'collapsed' 类。这能很好地匹配文件树的场景。
        const isLargeInput = log.type === 'input' && logContent.length > 500 && logContent.includes('\n');
        const collapsedClass = isLargeInput ? 'collapsed' : '';

        return `<div class="log-item log-${log.type} ${collapsedClass}"><div class="log-header">${iconHtml}<span>${titleText}</span></div><div class="log-content-wrapper">${content}</div></div>`;
    }

    private renderStreamedContent(content: string): string {
        const htmlContent = marked.parse(content, { gfm: true, breaks: true });
        return `<div class="log-item log-llm-stream"><div class="log-header">${this.getIconForLogType('llm-stream')}<span>LLM Response</span></div><div class="markdown-body">${htmlContent}</div></div>`;
    }

    private getIconForStatus(status: string): string {
        switch (status) {
            case 'running': return '<i class="codicon codicon-loading codicon-spin"></i>';
            case 'completed': return '<i class="codicon codicon-check"></i>';
            case 'failed': return '<i class="codicon codicon-error"></i>';
            case 'waiting': return '<i class="codicon codicon-more"></i>';
            default: return '';
        }
    }

    private renderFinalResult(): string {
        if (!this.agentResult) return '';

        let finalResultAnimationClass = '';
        if (!this.animatedStepIds.has('__agent_final_result__')) {
            finalResultAnimationClass = 'needs-animation';
            this.animatedStepIds.add('__agent_final_result__');
        }

        const resultClass = this.agentResult.status;
        const icon = resultClass === 'completed' ? '<i class="codicon codicon-check-all"></i>' : '<i class="codicon codicon-error"></i>';
        const title = resultClass === 'completed' ? 'Agent Execution Completed' : 'Agent Execution Failed';
        let contentHtml = '';

        if (resultClass === 'completed' && this.agentResult.stats) {
            const stats = this.agentResult.stats;
            contentHtml = `
                <div class="result-stats">
                    <div class="stat-item">
                        <i class="codicon codicon-clock"></i>
                        <span>耗时</span>
                        <strong>${stats.duration}</strong>
                    </div>
                    <div class="stat-item">
                        <i class="codicon codicon-symbol-event"></i>
                        <span>总 Tokens</span>
                        <strong>${stats.totalTokens.toLocaleString()}</strong>
                    </div>
                    <div class="stat-item">
                        <i class="codicon codicon-arrow-right"></i>
                        <span>输入 Tokens</span>
                        <strong>${stats.promptTokens.toLocaleString()}</strong>
                    </div>
                    <div class="stat-item">
                        <i class="codicon codicon-arrow-left"></i>
                        <span>输出 Tokens</span>
                        <strong>${stats.completionTokens.toLocaleString()}</strong>
                    </div>
                </div>
            `;
        } else if (resultClass !== 'completed') {
            contentHtml = `<div class="error-text">${this.agentResult.error || '未知错误'}</div>`;
        }
        return `<div class="agent-final-result ${resultClass} ${finalResultAnimationClass}"><div class="result-header">${icon}<span>${title}</span></div><div class="result-content">${contentHtml}</div></div>`;
    }

    private setupEventListeners() {
        this.element.addEventListener('click', (e) => { // 委托到根元素 this.element
            const target = e.target as HTMLElement;

            // 新增：处理日志卡片头部的点击事件，用于折叠/展开
            const logHeader = target.closest('.log-header');
            if (logHeader) {
                const logItem = logHeader.closest('.log-item');
                if (logItem) {
                    // 阻止事件冒泡，以防它触发了更外层（如步骤）的折叠事件
                    e.stopPropagation();
                    logItem.classList.toggle('collapsed');
                    return; // 处理完毕，提前返回
                }
            }

            // --- 规划视图的交互 ---
            const planningView = target.closest('.planning-view:not(.read-only)');
            if (planningView) {
                const executeBtn = target.closest('.execute-btn');
                if (executeBtn) {
                    // 收集参数并调用 onExecute
                    const params: Record<string, any> = {};
                    let allValid = true;

                    this.plan.parameters.forEach(p => {
                        const input = this.element.querySelector(`#param-${p.name}`) as HTMLInputElement;
                        if (input) {
                            const value = input.value.trim();
                            // 简单的非空验证
                            if (!value && p.type === 'path') { // 假设 path 类型是必需的
                                p.error = 'This field is required.';
                                allValid = false;
                            } else {
                                p.error = undefined;
                                params[p.name] = value;
                                p.value = value; // 更新内部状态
                            }
                        }
                    });

                    this.status = allValid ? 'executing' : 'validating';
                    this.render(); // 重新渲染以显示错误或进入执行状态

                    if (allValid) {
                        this.onExecute(params); // 将收集到的参数传递出去
                    }
                    return;
                }
                if (target.closest('.cancel-btn')) {
                    this.element.remove();
                    // 可能需要通知 ChatView 这个 block 被移除了
                    return;
                }
            }

            // --- 文件卡片点击 ---
            const fileCard = target.closest('.file-card');
            if (fileCard) {
                e.stopPropagation(); // Prevent other clicks if needed
                const filePath = (fileCard as HTMLElement).dataset.filePath;
                if (filePath) {
                    console.log('[AgentRunBlock] File card clicked, path:', filePath); // For debugging
                    vscode.postMessage({ command: 'viewFile', payload: { path: filePath } });
                }
                return;
            }

            // --- 步骤折叠/展开 ---
            const stepHeader = target.closest('.step-header, .sub-step-header');
            if (stepHeader) {
                e.stopPropagation();
                const stepElement = stepHeader.closest('.execution-step, .sub-step');

                if (stepElement instanceof HTMLElement) {
                    const stepName = stepElement.dataset.stepName;
                    const taskId = stepElement.dataset.taskId;
                    const key = taskId || stepName;

                    if (key) {
                        const state = this.executionState.get(key);
                        if (state) {
                            state.isCollapsed = !state.isCollapsed;
                            // 只更新这个特定元素的折叠状态，而不是完全重绘
                            const contentWrapper = stepElement.querySelector('.step-content-wrapper, .sub-step-content-wrapper') as HTMLElement;
                            if (contentWrapper) {
                                const isParallel = stepElement.classList.contains('execution-step') && !!stepElement.querySelector('.sub-steps-container');
                                contentWrapper.style.maxHeight = state.isCollapsed ? '0' : (isParallel ? '5000px' : '2000px');
                                contentWrapper.style.padding = state.isCollapsed ? '0 15px' : '10px 15px';
                            }
                        }
                    }
                }
                return;
            }
        });
    }

    private postRender() { /* For future use */ }
}