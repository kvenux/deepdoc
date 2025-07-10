// --- file_path: webview/components/AgentRunBlock.ts ---

import { AgentPlan, AgentResult, StepExecution, StepUpdate, StreamChunk, AgentPlanStep, StepResult as CommonStepResultType, AgentRunRecord, SavedStepState } from '../../common/types'; 
import { marked } from 'marked';
import { vscode } from '../vscode';

type AgentStatus = 'planning' | 'validating' | 'executing' | 'completed' | 'failed' | 'cancelled';

interface ExecutionStepState extends StepExecution {
    logs: { type: 'input' | 'output' | 'llm-request', data: any, metadata?: Record<string, any> }[];
    isCollapsed: boolean;
    streamedContent: string;
    error?: string;
}

// 类型守卫，用于区分 AgentPlan 和 AgentRunRecord
function isAgentRunRecord(data: AgentPlan | AgentRunRecord): data is AgentRunRecord {
    return (data as AgentRunRecord).result !== undefined;
}

export class AgentRunBlock {
    private element: HTMLElement;
    private plan: AgentPlan;
    private onExecute: ((params: Record<string, any>) => void) | null = null; // 可为 null
    private status: AgentStatus = 'planning';
    private executionState: Map<string, ExecutionStepState> = new Map();
    private agentResult: AgentResult | null = null;
    private animatedStepIds: Set<string> = new Set();
    private stepElementsCache: Map<string, HTMLElement> = new Map();
    private executionStepsOuterContainer: HTMLElement | null = null; // Cache this
    private runId: string | null = null;
    private onCancel?: () => void; // 新增 onCancel 属性

    constructor(
        container: HTMLElement,
        // 构造函数现在可以接收一个 AgentPlan（用于新的运行）或一个 AgentRunRecord（用于从历史恢复）
        planOrRecord: AgentPlan | AgentRunRecord,
        onExecute?: (params: Record<string, any>) => void,
        onCancel?: () => void // 在构造函数中接收回调
    ) {
        this.element = container;
        this.element.className = 'agent-run-block';
        
        if (isAgentRunRecord(planOrRecord)) {
            // 从历史记录中恢复
            const record = planOrRecord;
            this.plan = record.plan;
            this.agentResult = record.result;
            this.status = record.result.status as AgentStatus;
            this.runId = record.result.runId;
            // 将保存的普通对象转换回 Map
            this.executionState = new Map(Object.entries(record.executionState).map(([key, value]) => {
                // 确保每个步骤状态都符合 ExecutionStepState 接口
                const fullStepState: ExecutionStepState = {
                    runId: record.result.runId, // 从顶层结果中恢复 runId
                    stepName: value.stepName,
                    taskId: value.taskId,
                    status: value.status,
                    logs: value.logs || [],
                    isCollapsed: true, // 从历史记录加载时默认折叠
                    streamedContent: value.streamedContent || '',
                    error: value.error,
                };
                return [key, fullStepState];
            }));
            this.onExecute = null; // 历史记录是只读的
            this.onCancel = undefined; // 历史记录没有取消功能
        } else {
            // 开始一个新的运行
            this.plan = planOrRecord;
            this.onExecute = onExecute || null;
            this.onCancel = onCancel; // 保存回调
            this.status = 'planning';
        }

        this.render(); // Initial render
        this.setupEventListeners();
    }
    
    /**
     * 新增：获取组件当前的可序列化状态，用于保存到历史记录。
     */
    public getSerializableState(): AgentRunRecord | null {
        if (!this.agentResult) {
            console.error("Cannot serialize state: Agent has not completed.");
            return null;
        }

        
        // 将 Map 转换为普通对象以便 JSON 序列化
        const serializableExecutionState: Record<string, SavedStepState> = {};
        this.executionState.forEach((state, key) => {
            // 从 state 中只选择要保存的字段
            serializableExecutionState[key] = {
                stepName: state.stepName,
                taskId: state.taskId,
                status: state.status,
                logs: state.logs,
                streamedContent: state.streamedContent,
                error: state.error,
            };
        });
        

        return {
            plan: this.plan,
            executionState: serializableExecutionState,
            result: this.agentResult
        };
    }

    // Called by ChatView when agent:stepStart or agent:stepEnd is received
    public updateStepExecutionStatus(stepEventData: StepExecution | CommonStepResultType) {
        if (!this.runId) {
            this.runId = stepEventData.runId;
        }
        const stepKey = stepEventData.taskId || stepEventData.stepName;
        let stepState = this.executionState.get(stepKey);
        const isNewStepInState = !stepState;

        if (isNewStepInState) {
            // This is a StepExecution event for a new step/task
            stepState = { ...(stepEventData as StepExecution), logs: [], isCollapsed: false, streamedContent: '' };
        } else {
            // This is an update for an existing step (either StepExecution or StepResult)
            stepState!.status = stepEventData.status;
        }
        
        if (stepEventData.status === 'failed' && 'error' in stepEventData && stepEventData.error) {
            stepState!.error = stepEventData.error;
        }
        this.executionState.set(stepKey, stepState!);

        const isSubStep = stepState!.stepName.startsWith("分析模块:"); // Heuristic for sub-steps

        if (isNewStepInState) {
            // New step appearing in the execution flow
            if (isSubStep) {
                // Try to update parent's sub-step container directly
                const parentPlanStep = this.plan.steps.find(p => p.name === "分析: 并行处理模块"); // More robust way to find parent needed
                if (parentPlanStep) {
                    const parentStepState = Array.from(this.executionState.values()).find(
                        s => s.stepName === parentPlanStep.name && s.runId === stepState!.runId
                    );
                    if (parentStepState) {
                        const parentKey = parentStepState.taskId || parentStepState.stepName;
                        const parentElement = this.stepElementsCache.get(parentKey);
                        if (parentElement) {
                            const subStepsContainer = parentElement.querySelector('.sub-steps-container') as HTMLElement;
                            if (subStepsContainer) {
                                this.updateSubStepsContainerRendering(subStepsContainer, parentStepState);
                                return; // Handled locally
                            }
                        }
                    }
                }
            }
            // Fallback to full render if sub-step parent not found/rendered, or if it's a new top-level step
            this.render();
        } else {
            // Status update for an existing, rendered step
            const stepElement = this.stepElementsCache.get(stepKey);
            if (stepElement) {
                this.updateElementHeaderAndError(stepElement, stepState!);
            }
        }
    }


    public addStepLog(update: StepUpdate) {
        const stepKey = update.taskId ||
            (this.plan.steps.find(s => s.name === update.metadata?.stepNameHint)?.name) ||
            'global_logs';

        const stepState = this.executionState.get(stepKey) || Array.from(this.executionState.values()).find(s => s.stepName === stepKey);

        if (stepState && (update.type === 'input' || update.type === 'output' || update.type === 'llm-request')) {
            stepState.logs.push({ type: update.type, data: update.data, metadata: update.metadata });

            const stepElement = this.stepElementsCache.get(stepKey);
            if (stepElement) {
                const logsContainer = stepElement.querySelector('.logs-wrapper') as HTMLElement;
                if (logsContainer) {
                    // 2.【核心修改】放弃增量 append，改为完全重绘
                    
                    // 先清空所有旧的日志卡片
                    logsContainer.innerHTML = ''; 

                    // 3. 遍历最新的日志数组，重新创建并添加每一个日志卡片
                    stepState.logs.forEach(log => {
                        // 调用 renderLogItem 生成一个全新的、干净的 DOM 元素
                        const newLogElement = this.renderLogItem(log);
                        // 添加到容器中，这次绝对不会嵌套
                        logsContainer.appendChild(newLogElement);
                    });

                    // 4. (可选但推荐) 滚动到底部，以便看到最新的日志
                    logsContainer.scrollTop = logsContainer.scrollHeight;
                }
            }
        }
    }

    public appendStreamChunk(chunk: StreamChunk) {
        const stepKey = chunk.taskId;
        if (!stepKey) {
            console.warn('AgentRunBlock: StreamChunk received without taskId.', chunk);
            return;
        }

        const stepState = this.executionState.get(stepKey);
        if (stepState) {
            stepState.streamedContent += chunk.content;

            const stepElement = this.stepElementsCache.get(stepKey);
            if (stepElement) {
                const contentWrapper = stepElement.querySelector(stepElement.classList.contains('sub-step') ? '.sub-step-content-wrapper' : '.step-content-wrapper') as HTMLElement;
                if (contentWrapper) {
                    let streamWrapper = contentWrapper.querySelector('.stream-wrapper') as HTMLElement;
                    if (!streamWrapper) {
                        // If stream wrapper doesn't exist, create it (e.g. by re-rendering internals for this step)
                        // This is a fallback; ideally, renderStepInternals would have set it up.
                        // A simpler approach for now is to just re-render the step's internals fully if the stream wrapper isn't found.
                        // However, a more robust way is to ensure renderStepInternals always creates these wrappers.
                        contentWrapper.innerHTML = this.renderStepInternals(stepState); //This will create the stream-wrapper
                        streamWrapper = contentWrapper.querySelector('.stream-wrapper') as HTMLElement; // Re-query
                    }
                    if (streamWrapper) {
                        streamWrapper.innerHTML = this.renderStreamedContent(stepState.streamedContent); // renderStreamedContent returns HTML for the content *inside* the wrapper
                    }
                }
            }
        } else {
            console.warn(`AgentRunBlock: Could not find step state for taskId '${stepKey}' to append stream chunk.`);
        }
    }

    public setAgentResult(result: AgentResult) {
        this.status = result.status;
        this.agentResult = result;
        // 如果Agent被取消或失败，遍历所有正在执行的步骤，并将它们标记为失败。
        if (result.status === 'cancelled' || result.status === 'failed') {
            this.executionState.forEach(stepState => {
                if (stepState.status === 'running' || stepState.status === 'waiting') {
                    stepState.status = 'failed'; // 将状态强制更新为 'failed'
                    // 可以添加一条错误信息，解释为什么这个步骤失败了
                    stepState.error = 'Execution was cancelled or failed.'; 
                }
            });
        }
        this.render();
    }

    private render() {
        // 如果 onExecute 为 null，说明是从历史记录中恢复的，始终为只读状态
        const isPlanningReadOnly = (this.status !== 'planning' && this.status !== 'validating') || this.onExecute === null;

        const planningViewContainer = this.element.querySelector('.planning-view-container');
        if (!planningViewContainer) {
            this.element.innerHTML = `<div class="planning-view-container"></div><div class="executing-view-container"></div>`;
        }
        const planningContainer = this.element.querySelector('.planning-view-container') as HTMLElement;
        planningContainer.innerHTML = this.renderPlanningView(isPlanningReadOnly);

        const executingViewContainer = this.element.querySelector('.executing-view-container') as HTMLElement;
        if (isPlanningReadOnly) {
            if (!executingViewContainer.classList.contains('active')) {
                this.animatedStepIds.clear();
                // Do NOT clear stepElementsCache here if we want to preserve elements across minor re-renders
                // this.stepElementsCache.clear(); 
                executingViewContainer.classList.add('active');
            }
            this.renderExecutingViewContents(executingViewContainer);
        } else {
            executingViewContainer.classList.remove('active');
            executingViewContainer.innerHTML = '';
        }
        this.postRender();
    }

    private renderExecutingViewContents(container: HTMLElement) {
        const statusClassMapping: Record<AgentStatus, string> = { /* ... */ planning: 'planning', validating: 'planning', executing: 'executing', completed: 'completed', failed: 'failed', cancelled: 'failed'};
        const statusClass = statusClassMapping[this.status] || 'executing';
        const statusText = this.status.charAt(0).toUpperCase() + this.status.slice(1);

        if (!this.executionStepsOuterContainer || !container.contains(this.executionStepsOuterContainer)) {
            container.innerHTML = `
            <div class="executing-view">
                <div class="agent-header">
                    <h4>执行过程</h4>
                    <span class="badge ${statusClass}">${statusText}</span>
                </div>
                <div class="execution-steps-outer-container"></div>
                <div class="final-result-container"></div>
            </div>`;
            this.executionStepsOuterContainer = container.querySelector('.execution-steps-outer-container') as HTMLElement;
        } else {
            const badge = container.querySelector('.executing-view .agent-header .badge') as HTMLElement;
            if (badge) {
                badge.className = `badge ${statusClass}`;
                badge.textContent = statusText;
            }
        }
        
        // Ensure executionStepsOuterContainer is defined
        if (!this.executionStepsOuterContainer) {
             this.executionStepsOuterContainer = container.querySelector('.execution-steps-outer-container') as HTMLElement;
             if (!this.executionStepsOuterContainer) return; // Should not happen
        }

        // 清理旧的DOM元素，并根据当前状态重新渲染
        this.executionStepsOuterContainer.innerHTML = '';
        this.stepElementsCache.clear();

        this.plan.steps.forEach((planStep, index) => {
            // 从 state 中找到所有与 planStep 匹配的顶级执行步骤
            // 这很重要，因为从历史恢复时，executionState 是预先填充好的
            const executionStepState = Array.from(this.executionState.values())
                .find(s => s.stepName === planStep.name && !s.stepName.startsWith("分析模块:"));

            if (!executionStepState) {
                // 如果是实时执行，可能会暂时没有状态，直接跳过
                // 如果是从历史恢复，这里不应该发生
                return;
            }

            const stepMapKey = executionStepState.taskId || executionStepState.stepName;
            let stepElement = this.stepElementsCache.get(stepMapKey);

            if (!stepElement) {
                let animationClass = '';
                 // 从历史恢复时，不应用动画
                if (!isAgentRunRecord(this.plan) && !this.animatedStepIds.has(stepMapKey)) {
                    animationClass = 'needs-animation';
                    this.animatedStepIds.add(stepMapKey);
                }
                const isParallel = planStep.name === "分析: 并行处理模块"; // Heuristic
                const stepHtml = isParallel
                    ? this.getParallelAnalysisStepHtml(planStep, index, executionStepState, animationClass)
                    : this.getExecutionStepHtml(executionStepState, planStep, index, animationClass);

                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = stepHtml.trim();
                stepElement = tempDiv.firstChild as HTMLElement;

                if (stepElement) {
                    this.executionStepsOuterContainer!.appendChild(stepElement);
                    this.stepElementsCache.set(stepMapKey, stepElement);
                }
            } else {
                 // 理论上，因为我们清理了 outer container，这个分支在当前逻辑下不会被走到
                this.updateStepElement(stepElement, executionStepState, planStep, planStep.name === "分析: 并行处理模块", index);
            }
        });

        const finalResultContainer = container.querySelector('.final-result-container') as HTMLElement;
        if (this.agentResult) {
            this.renderOrUpdateFinalResult(finalResultContainer);
        } else {
            finalResultContainer.innerHTML = '';
        }
    }

    private updateStepElement(element: HTMLElement, stepState: ExecutionStepState, planStep: AgentPlanStep, isParallel: boolean, index: number) {
        this.updateElementHeaderAndError(element, stepState); // Update header and error

        const contentWrapper = element.querySelector('.step-content-wrapper') as HTMLElement;
        if (contentWrapper) {
            contentWrapper.style.maxHeight = stepState.isCollapsed ? '0' : (isParallel ? '5000px' : '2000px');
            contentWrapper.style.padding = stepState.isCollapsed ? '0 15px' : '10px 15px';

            if (isParallel) {
                const subStepsContainer = contentWrapper.querySelector('.sub-steps-container') as HTMLElement;
                if (subStepsContainer) {
                    this.updateSubStepsContainerRendering(subStepsContainer, stepState);
                }
            } else {
                // Only set innerHTML for content if the wrapper is empty (initial population)
                // OR if there are logs/stream/error to display and it wasn't populated before.
                // This prevents re-rendering content if it's managed by targeted updates.
                const needsContentPopulation = !contentWrapper.querySelector('.logs-wrapper') && !contentWrapper.querySelector('.stream-wrapper');
                if (needsContentPopulation && (stepState.logs.length > 0 || stepState.streamedContent || stepState.error)) {
                    contentWrapper.innerHTML = this.renderStepInternals(stepState);
                } else if (contentWrapper.children.length === 0 && (stepState.logs.length > 0 || stepState.streamedContent || stepState.error)) {
                    // Fallback if specific wrappers are not used and content is empty
                    contentWrapper.innerHTML = this.renderStepInternals(stepState);
                }
                // If content exists, assume addStepLog/appendStreamChunk will handle it.
            }
        }
    }
    
    // New helper to specifically update header and error parts of a step element
    private updateElementHeaderAndError(element: HTMLElement, stepState: ExecutionStepState) {
        const baseClass = element.classList.contains('sub-step') ? 'sub-step' : 'execution-step';
        element.className = `${baseClass} ${stepState.status}`; // Animation might be re-added if logic desires

        const statusIconEl = element.querySelector('.status-icon');
        if (statusIconEl) statusIconEl.innerHTML = this.getIconForStatus(stepState.status);
        
        const stepStatusEl = element.querySelector('.step-status'); // For top-level steps
        if (stepStatusEl) stepStatusEl.textContent = stepState.status;

        // Update error message
        let errorWrapper = element.querySelector('.step-error-wrapper') as HTMLElement;
        if (stepState.error) {
            if (!errorWrapper) {
                // Find content wrapper to append error to
                const contentWrapper = element.querySelector(baseClass === 'sub-step' ? '.sub-step-content-wrapper' : '.step-content-wrapper') as HTMLElement;
                if (contentWrapper) {
                    errorWrapper = document.createElement('div');
                    errorWrapper.className = 'step-error-wrapper';
                    contentWrapper.appendChild(errorWrapper); // Append, not replace all content
                }
            }
            if (errorWrapper) errorWrapper.innerHTML = `<div class="step-error">${stepState.error}</div>`;
        } else {
            if (errorWrapper) errorWrapper.innerHTML = ''; // Clear error
        }
    }


    private updateSubStepsContainerRendering(container: HTMLElement, parentStepState: ExecutionStepState) {
        const subStepStates = Array.from(this.executionState.values()).filter(s =>
            s.stepName.startsWith("分析模块:") && s.runId === parentStepState.runId
        );

        const existingSubStepElements = new Map<string, HTMLElement>();
        container.querySelectorAll<HTMLElement>('.sub-step').forEach(el => {
            if (el.dataset.taskId) existingSubStepElements.set(el.dataset.taskId, el);
        });
        
        let newHtmlForSubSteps = '';
        if (subStepStates.length > 0) {
            newHtmlForSubSteps = subStepStates.map(subState => {
                 const subStepKey = subState.taskId!;
                 let animationClass = '';
                 // Check if this sub-step was already animated or if it's new to this render pass
                 if (!this.animatedStepIds.has(subStepKey) && !existingSubStepElements.has(subStepKey)) {
                     animationClass = 'needs-animation';
                     // this.animatedStepIds.add(subStepKey); // Add when actually appended
                 }
                const existingElement = existingSubStepElements.get(subStepKey);
                if (existingElement) {
                     // If exists, we might want to preserve it and update, but for now, full re-render of sub-step list
                     // For more granular, we'd call updateStepElement on existingElement here.
                    // For simplicity in this pass, this method will still use innerHTML for the whole sub-steps list.
                    // A truly granular update would diff this list.
                }
                 return this.getSubStepHtml(subState, animationClass);
             }).join('');
        } else if (parentStepState.status === 'running') {
            newHtmlForSubSteps = '<div class="sub-step-placeholder">等待模块分析任务启动...</div>';
        }
        
        container.innerHTML = newHtmlForSubSteps;

        // After setting innerHTML, re-query and add new animated IDs
        container.querySelectorAll<HTMLElement>('.sub-step.needs-animation').forEach(el => {
            if (el.dataset.taskId) this.animatedStepIds.add(el.dataset.taskId);
        });
        // Also update cache for new sub-steps
        subStepStates.forEach(subState => {
            const subStepKey = subState.taskId!;
            if (!this.stepElementsCache.has(subStepKey)) {
                const newEl = container.querySelector(`.sub-step[data-task-id="${subStepKey}"]`) as HTMLElement;
                if (newEl) this.stepElementsCache.set(subStepKey, newEl);
            }
        });
    }

    private renderStepInternals(stepState: ExecutionStepState): string {
        // Ensure this method creates the distinct wrappers
        const logsHtml = stepState.logs.map(log => this.renderLogItemToString(log)).join(''); // Temporarily back to string
        let waitingPlaceholderHtml = '';
        // ... (waiting placeholder logic) ...
        const streamRendered = this.renderStreamedContent(stepState.streamedContent); // This returns HTML for *inside* the stream wrapper
        const errorHtml = stepState.error ? `<div class="step-error">${stepState.error}</div>` : '';

        return `
            <div class="logs-wrapper">${logsHtml}</div>
            ${waitingPlaceholderHtml}
            <div class="stream-wrapper">${streamRendered}</div>
            <div class="step-error-wrapper">${errorHtml}</div>
        `;
    }
    
    // New: Renders a single log item to an HTML string for renderStepInternals
    private renderLogItemToString(log: { type: string, data: any, metadata?: Record<string, any> }): string {
        // ... (logic from original renderLogItem to build HTML string for one log) ...
        let content = '';
        const logDataName = log.data && typeof log.data === 'object' && 'name' in log.data ? log.data.name : '';
        const logContent = log.data && typeof log.data === 'object' && 'content' in log.data
            ? (typeof log.data.content === 'string' ? log.data.content : JSON.stringify(log.data.content, null, 2))
            : (typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2));

        if (log.metadata?.type === 'file') {
            content = this.renderFileCard(log.metadata.path, logDataName);
        } else {
            content = `<pre><code>${logContent}</code></pre>`;
        }
        const iconHtml = this.getIconForLogType(log.type);
        const titleText = `${log.type.toUpperCase()}${logDataName ? ': ' + logDataName : ''}`;
        const isLargeInput = log.type === 'input' && logContent.length > 500 && logContent.includes('\n');
        const collapsedClass = isLargeInput ? 'collapsed' : '';

        return `<div class="log-item log-${log.type} ${collapsedClass}"><div class="log-header">${iconHtml}<span>${titleText}</span></div><div class="log-content-wrapper">${content}</div></div>`;
    }

    // Changed: renderLogItem now returns HTMLElement for direct DOM append
    private renderLogItem(log: { type: string, data: any, metadata?: Record<string, any> }): HTMLElement {
        let content = '';
        const logDataName = log.data && typeof log.data === 'object' && 'name' in log.data ? log.data.name : '';
        const logContentText = log.data && typeof log.data === 'object' && 'content' in log.data
            ? (typeof log.data.content === 'string' ? log.data.content : JSON.stringify(log.data.content, null, 2))
            : (typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2));

        if (log.metadata?.type === 'file') {
            content = this.renderFileCard(log.metadata.path, logDataName);
        } else {
            content = `<pre><code>${logContentText}</code></pre>`;
        }
        const iconHtml = this.getIconForLogType(log.type);
        const titleText = `${log.type.toUpperCase()}${logDataName ? ': ' + logDataName : ''}`;
        const isLargeInput = log.type === 'input' && logContentText.length > 500 && logContentText.includes('\n');
        const collapsedClass = isLargeInput ? 'collapsed' : '';
        
        const logItemElement = document.createElement('div');
        logItemElement.className = `log-item log-${log.type} ${collapsedClass}`;
        logItemElement.innerHTML = `<div class="log-header">${iconHtml}<span>${titleText}</span></div><div class="log-content-wrapper">${content}</div>`;
        return logItemElement;
    }


    private renderStreamedContent(content: string): string {
        // This method returns the HTML string for the *content* of the stream wrapper
        if (!content) return '';
        const htmlContent = marked.parse(content, { gfm: true, breaks: true });
        // The class 'markdown-body' should be on the wrapper if specific styling is needed
        return `<div class="markdown-body">${htmlContent}</div>`; 
    }

    // --- Other methods (getExecutionStepHtml, getParallelAnalysisStepHtml, getSubStepHtml, renderPlanningView, etc.) largely remain the same for initial HTML string generation ---
    // Make sure they call renderStepInternals when creating content.

    private getExecutionStepHtml(stepState: ExecutionStepState, planStep: { name: string }, index: number, animationClass: string): string {
        const state = stepState.status;
        const taskIdAttr = stepState.taskId ? `data-task-id="${stepState.taskId}"` : '';
        const contentWrapperStyle = stepState.isCollapsed ? 'max-height: 0px; padding: 0px 15px;' : 'max-height: 2000px; padding: 10px 15px;';
        return `
            <div class="execution-step ${state} ${animationClass}" data-step-name="${planStep.name}" ${taskIdAttr}>
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content-wrapper" style="${contentWrapperStyle}">
                    ${this.renderStepInternals(stepState)}
                </div>
            </div>
        `;
    }

    private getParallelAnalysisStepHtml(planStep: AgentPlanStep, index: number, parentStepState: ExecutionStepState, animationClass: string): string {
        const state = parentStepState.status;
        const taskIdAttr = parentStepState.taskId ? `data-task-id="${parentStepState.taskId}"` : '';
        // Initial sub-steps rendering (likely empty or placeholder if just started)
        const subStepsHtml = this.renderSubStepsContainerInitial(parentStepState);
        const contentWrapperStyle = parentStepState.isCollapsed ? 'max-height: 0px; padding: 0px 15px;' : 'max-height: 5000px; padding: 10px 15px;';

        return `
            <div class="execution-step ${state} ${animationClass}" data-step-name="${planStep.name}" ${taskIdAttr}>
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content-wrapper" style="${contentWrapperStyle}">
                     <div class="sub-steps-container">
                        ${subStepsHtml}
                    </div>
                    ${this.renderStepInternals(parentStepState)} 
                </div>
            </div>
        `;
    }
    
    // Renders the initial HTML for the sub-steps container (used during creation of parent step)
    private renderSubStepsContainerInitial(parentStepState: ExecutionStepState): string {
        const subSteps = Array.from(this.executionState.values()).filter(s =>
            s.stepName.startsWith("分析模块:") && s.runId === parentStepState.runId
        );
        if (subSteps.length > 0) {
            return subSteps.map(sub => {
                const subStepMapKey = sub.taskId || sub.stepName;
                let subAnimationClass = ''; // No animation on initial parent render for existing sub-steps
                return this.getSubStepHtml(sub, subAnimationClass);
            }).join('');
        } else if (parentStepState.status === 'running' || parentStepState.status === 'waiting') {
            return '<div class="sub-step-placeholder">等待模块分析任务启动...</div>';
        }
        return '';
    }


    private getSubStepHtml(subStep: ExecutionStepState, animationClass: string): string {
        const contentWrapperStyle = subStep.isCollapsed ? 'max-height: 0px; padding: 0px 10px;' : 'max-height: 2000px; padding: 10px;';
        return `
            <div class="sub-step ${subStep.status} ${animationClass}" data-task-id="${subStep.taskId}">
                 <div class="sub-step-header">
                    <span class="status-icon">${this.getIconForStatus(subStep.status)}</span>
                    <span class="step-name">${subStep.stepName}</span>
                </div>
                <div class="sub-step-content-wrapper" style="${contentWrapperStyle}">
                    ${this.renderStepInternals(subStep)}
                </div>
            </div>
        `;
    }
    
    // renderPlanningView, renderStepCard, renderParameterInput, getIconForStatus, renderFinalResult, setupEventListeners, postRender remain the same
    private renderPlanningView(isReadOnly: boolean): string {
        const badgeClass = this.status === 'planning' || this.status === 'validating' ? 'planning' : (this.status === 'executing' ? 'executing' : 'completed');
        const badgeText = this.status === 'planning' || this.status === 'validating' ? '待执行' : (this.status === 'executing' ? '运行中' : '规划已锁定');

        const renderAgentActions = (status: AgentStatus) => {
            // 如果 onExecute 为 null (从历史恢复)，则不显示任何操作按钮
            if (this.onExecute === null) {
                return '';
            }
            if (status === 'executing') {
                return `<button class="stop-btn secondary"><i class="codicon codicon-stop-circle"></i> 停止执行</button>`;
            }
            if (status === 'planning' || status === 'validating') {
                return `
                    <button class="execute-btn"><i class="codicon codicon-play"></i> 开始执行</button>
                    <button class="cancel-btn secondary"><i class="codicon codicon-close"></i> 取消</button>
                `;
            }
            return '';
        };

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
                <div class="agent-actions" style="display: ${this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled' ? 'none' : 'flex'};">
                    ${renderAgentActions(this.status)}
                </div>
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
                <div class="parameter-description">${param.description}</div>
                <input type="text" id="param-${param.name}" name="${param.name}" class="${isInvalid}" value="${value}" ${isReadOnly ? 'disabled' : ''}>
                ${param.error ? `<div class="error-text">${param.error}</div>` : ''}
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
    private getIconForStatus(status: string): string {
        switch (status) {
            case 'running': return '<i class="codicon codicon-loading codicon-spin"></i>';
            case 'completed': return '<i class="codicon codicon-check"></i>';
            case 'failed': return '<i class="codicon codicon-error"></i>';
            case 'waiting': return '<i class="codicon codicon-more"></i>';
            default: return '';
        }
    }
    private renderOrUpdateFinalResult(container: HTMLElement) { // Was renderFinalResult()
        if (!this.agentResult) {
            container.innerHTML = '';
            this.stepElementsCache.delete('__agent_final_result__');
            return;
        }

        let resultElement = this.stepElementsCache.get('__agent_final_result__');
        const resultKey = '__agent_final_result__';
        let animationClass = '';

        if (!resultElement) {
            // 从历史恢复时，不应用动画
            if (!isAgentRunRecord(this.plan) && !this.animatedStepIds.has(resultKey)) {
                animationClass = 'needs-animation';
                this.animatedStepIds.add(resultKey);
            }
            const resultHtml = this.getFinalResultHtml(animationClass); 
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = resultHtml.trim();
            resultElement = tempDiv.firstChild as HTMLElement;
            if (resultElement) {
                container.innerHTML = ''; 
                container.appendChild(resultElement);
                this.stepElementsCache.set(resultKey, resultElement);
            }
        } else {
            resultElement.className = `agent-final-result ${this.agentResult.status} ${animationClass}`;
            const iconEl = resultElement.querySelector('.result-header .codicon') as HTMLElement;
            const titleEl = resultElement.querySelector('.result-header span') as HTMLElement;
            const contentEl = resultElement.querySelector('.result-content') as HTMLElement;

            const isCompleted = this.agentResult.status === 'completed';
            if (iconEl) iconEl.className = `codicon ${isCompleted ? 'codicon-check-all' : 'codicon-error'}`;
            if (titleEl) titleEl.textContent = isCompleted ? 'Agent Execution Completed' : 'Agent Execution Failed';

            if (contentEl) {
                let newContentHtml = '';
                 if (isCompleted && this.agentResult.stats) {
                    const stats = this.agentResult.stats;
                    newContentHtml = `
                        <div class="result-stats">
                            <div class="stat-item"><i class="codicon codicon-clock"></i><span>耗时</span><strong>${stats.duration}</strong></div>
                            <div class="stat-item"><i class="codicon codicon-symbol-event"></i><span>总 Tokens</span><strong>${stats.totalTokens.toLocaleString()}</strong></div>
                            <div class="stat-item"><i class="codicon codicon-arrow-right"></i><span>输入 Tokens</span><strong>${stats.promptTokens.toLocaleString()}</strong></div>
                            <div class="stat-item"><i class="codicon codicon-arrow-left"></i><span>输出 Tokens</span><strong>${stats.completionTokens.toLocaleString()}</strong></div>
                        </div>`;
                } else if (!isCompleted) {
                    newContentHtml = `<div class="error-text">${this.agentResult.error || '未知错误'}</div>`;
                }
                // Only update if different to avoid flicker
                if (contentEl.innerHTML !== newContentHtml) {
                     contentEl.innerHTML = newContentHtml;
                }
            }
        }
    }
    private getFinalResultHtml(animationClass: string): string {
        if (!this.agentResult) return '';
        const resultClass = this.agentResult.status;
        const icon = resultClass === 'completed' ? '<i class="codicon codicon-check-all"></i>' : '<i class="codicon codicon-error"></i>';
        const title = resultClass === 'completed' ? 'Agent Execution Completed' : 'Agent Execution Failed';
        let contentHtml = '';
        if (resultClass === 'completed' && this.agentResult.stats) {
            const stats = this.agentResult.stats;
            contentHtml = `
                <div class="result-stats">
                    <div class="stat-item"><i class="codicon codicon-clock"></i><span>耗时</span><strong>${stats.duration}</strong></div>
                    <div class="stat-item"><i class="codicon codicon-symbol-event"></i><span>总 Tokens</span><strong>${stats.totalTokens.toLocaleString()}</strong></div>
                    <div class="stat-item"><i class="codicon codicon-arrow-right"></i><span>输入 Tokens</span><strong>${stats.promptTokens.toLocaleString()}</strong></div>
                    <div class="stat-item"><i class="codicon codicon-arrow-left"></i><span>输出 Tokens</span><strong>${stats.completionTokens.toLocaleString()}</strong></div>
                </div>`;
        } else if (resultClass !== 'completed') {
            contentHtml = `<div class="error-text">${this.agentResult.error || '未知错误'}</div>`;
        }
        return `<div class="agent-final-result ${resultClass} ${animationClass}"><div class="result-header">${icon}<span>${title}</span></div><div class="result-content">${contentHtml}</div></div>`;
    }
    private setupEventListeners() {
        this.element.addEventListener('click', (e) => { 
            const target = e.target as HTMLElement;
            const logHeader = target.closest('.log-header');
            if (logHeader) {
                const logItem = logHeader.closest('.log-item');
                if (logItem) {
                    e.stopPropagation();
                    logItem.classList.toggle('collapsed');
                    return; 
                }
            }
            // Event listener for agent actions (start, stop, cancel)
            const actionsContainer = target.closest('.agent-actions');
            if (actionsContainer) {
                const executeBtn = target.closest('.execute-btn');
                const cancelBtn = target.closest('.cancel-btn');
                const stopBtn = target.closest('.stop-btn');

                if (executeBtn) {
                    if (!this.onExecute) return; // 从历史恢复时，onExecute 为 null
                    const params: Record<string, any> = {};
                    let allValid = true;
                    this.plan.parameters.forEach(p => {
                        const input = this.element.querySelector(`#param-${p.name}`) as HTMLInputElement;
                        if (input) {
                            const value = input.value.trim();
                            if (!value && p.type === 'path') { p.error = 'This field is required.'; allValid = false; }
                            else { p.error = undefined; params[p.name] = value; p.value = value; }
                        }
                    });
                    this.status = allValid ? 'executing' : 'validating';
                    this.render(); 
                    if (allValid) this.onExecute(params); 
                    return;
                }
                if (cancelBtn) {
                    // 如果 onCancel 回调存在，就调用它
                    if (this.onCancel) {
                        this.onCancel();
                    } else {
                        // 否则，作为后备，只移除元素（不应该发生）
                        this.element.remove();
                    }
                    return;
                }
                if (stopBtn) {
                    if (this.runId) {
                        vscode.postMessage({ command: 'agent:cancel', payload: { runId: this.runId } });
                    } else {
                        console.warn('Stop button clicked, but no runId is available.');
                        this.element.remove();
                    }
                    return;
                }
            }
            const fileCard = target.closest('.file-card');
            if (fileCard) {
                e.stopPropagation(); 
                const filePath = (fileCard as HTMLElement).dataset.filePath;
                if (filePath) {
                    vscode.postMessage({ command: 'viewFile', payload: { path: filePath } });
                }
                return;
            }
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