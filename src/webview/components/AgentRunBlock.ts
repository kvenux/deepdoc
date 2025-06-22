// --- file_path: webview/components/AgentRunBlock.ts ---

import { AgentPlan, AgentResult, StepExecution, StepUpdate, StreamChunk, AgentPlanStep } from '../../common/types';
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

    public updateStep(step: StepExecution) {
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
        const key = update.taskId || 'global';
        const stepState = this.executionState.get(key);
        if (stepState && (update.type === 'input' || update.type === 'output' || update.type === 'llm-request')) {
            stepState.logs.push({ type: update.type, data: update.data, metadata: update.metadata });
            this.render();
        }
    }

    public appendStreamChunk(chunk: StreamChunk) {
        const key = chunk.taskId || 'global';
        const stepState = this.executionState.get(key);
        if (stepState) {
            stepState.streamedContent += chunk.content;
            this.render();
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
        const planningViewHtml = this.renderPlanningView(isPlanningReadOnly);
        let executionViewHtml = '';
        if (isPlanningReadOnly) {
            executionViewHtml = this.renderExecutingView();
        }
        this.element.innerHTML = planningViewHtml + executionViewHtml;
        this.postRender();
    }

    private renderPlanningView(isReadOnly: boolean): string {
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
                        if (planStep.name === "执行: 并行分析所有模块") {
                            return this.renderParallelAnalysisStep(planStep, index);
                        } else {
                            const executionStep = Array.from(this.executionState.values()).find(s => s.stepName === planStep.name);
                            return this.renderExecutionStep(executionStep, planStep, index);
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

    private renderExecutionStep(stepState: ExecutionStepState | undefined, planStep: {name: string}, index: number): string {
        const state = stepState?.status || 'waiting';
        const isCollapsed = stepState ? stepState.isCollapsed : false;
        return `
            <div class="execution-step ${state}" data-step-name="${planStep.name}">
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content" style="max-height: ${isCollapsed ? '0' : '2000px'};">
                    ${stepState?.logs.map(log => this.renderLogItem(log)).join('') || ''}
                    ${stepState?.streamedContent ? this.renderStreamedContent(stepState.streamedContent) : ''}
                    ${stepState?.error ? `<div class="step-error">${stepState.error}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    private renderParallelAnalysisStep(planStep: AgentPlanStep, index: number): string {
        const parentStepState = Array.from(this.executionState.values()).find(s => s.stepName === planStep.name);
        const state = parentStepState?.status || 'waiting';
        const isCollapsed = parentStepState ? parentStepState.isCollapsed : false;
        const subSteps = Array.from(this.executionState.values()).filter(s => s.stepName.startsWith("分析模块:"));

        return `
            <div class="execution-step ${state}" data-step-name="${planStep.name}">
                <div class="step-header">
                    <span class="status-icon">${this.getIconForStatus(state)}</span>
                    <span class="step-name"><b>Step ${index + 1}:</b> ${planStep.name}</span>
                    <span class="step-status">${state}</span>
                </div>
                <div class="step-content" style="max-height: ${isCollapsed ? '0' : '5000px'};">
                    <div class="sub-steps-container">
                        ${subSteps.length > 0 ? subSteps.map(sub => this.renderSubStep(sub)).join('') : '<div class="sub-step-placeholder">等待模块分析任务启动...</div>'}
                    </div>
                </div>
            </div>
        `;
    }

    private renderSubStep(subStep: ExecutionStepState): string {
        const isSubStepCollapsed = subStep.isCollapsed ?? true;
        return `
            <div class="sub-step ${subStep.status}" data-task-id="${subStep.taskId}">
                 <div class="sub-step-header">
                    <span class="status-icon">${this.getIconForStatus(subStep.status)}</span>
                    <span class="step-name">${subStep.stepName}</span>
                </div>
                <div class="sub-step-content" style="max-height: ${isSubStepCollapsed ? '0' : '1000px'};">
                    ${subStep.logs.map(log => this.renderLogItem(log)).join('')}
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
        switch(logType) {
            case 'input': return '<i class="codicon codicon-arrow-right"></i>';
            case 'output': return '<i class="codicon codicon-arrow-left"></i>';
            case 'llm-request': return '<i class="codicon codicon-comment"></i>';
            case 'llm-stream': return '<i class="codicon codicon-wand"></i>';
            default: return '';
        }
    }

    private renderLogItem(log: { type: string, data: any, metadata?: Record<string, any> }): string {
        let content = '';
        if (log.metadata?.type === 'file') {
            content = this.renderFileCard(log.metadata.path, log.data.name);
        } else {
             const logContent = typeof log.data.content === 'string' 
                ? log.data.content
                : JSON.stringify(log.data.content, null, 2);
            content = `<pre><code>${logContent}</code></pre>`;
        }
        const iconHtml = this.getIconForLogType(log.type);
        const titleText = `${log.type.toUpperCase()}: ${log.data.name || ''}`;
        return `<div class="log-item log-${log.type}"><div class="log-header">${iconHtml}<span>${titleText}</span></div><div class="log-content-wrapper">${content}</div></div>`;
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
        const resultClass = this.agentResult.status;
        const icon = resultClass === 'completed' ? '<i class="codicon codicon-check-all"></i>' : '<i class="codicon codicon-error"></i>';
        const title = resultClass === 'completed' ? 'Agent Execution Completed' : 'Agent Execution Failed';
        let content;
        if (resultClass === 'completed') {
            const finalDocPath = '.codewiki/runs/.../项目总体设计文档.md';
            content = this.renderFileCard(finalDocPath, this.agentResult.finalOutput);
        } else {
            content = `<div class="error-text">${this.agentResult.error}</div>`;
        }
        return `<div class="agent-final-result ${resultClass}"><div class="result-header">${icon}<span>${title}</span></div><div class="result-content">${content}</div></div>`;
    }

    private setupEventListeners() {
        this.element.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;

            if (!this.element.querySelector('.planning-view.read-only')) {
                if (target.matches('.execute-btn')) {
                    const params: Record<string, any> = {};
                    let allValid = true;
                    this.plan.parameters.forEach(p => {
                        const input = this.element.querySelector(`#param-${p.name}`) as HTMLInputElement;
                        if (input) {
                            if (!input.value) {
                                p.error = 'This field is required.';
                                allValid = false;
                            } else {
                                p.error = '';
                                p.value = input.value;
                            }
                        }
                    });
                    this.status = allValid ? 'executing' : 'validating';
                    this.render();
                    if (allValid) { this.onExecute(params); }
                    return;
                }
                if (target.matches('.cancel-btn')) { this.element.remove(); return; }
            }
            
            const fileCard = target.closest('.file-card');
            if (fileCard) {
                e.stopPropagation();
                // 使用类型断言来告诉 TS fileCard 是一个 HTMLElement
                const filePath = (fileCard as HTMLElement).dataset.filePath;
                if (filePath) { vscode.postMessage({ command: 'viewFile', payload: { path: filePath } }); }
                return;
            }
            
            const stepHeader = target.closest('.step-header, .sub-step-header');
            if(stepHeader) {
                e.stopPropagation();
                const stepElement = stepHeader.closest('.execution-step, .sub-step');
                
                // highlight-start
                // 使用类型守卫来确保 stepElement 是一个 HTMLElement
                if (stepElement instanceof HTMLElement) {
                    const stepId = stepElement.dataset.stepName || stepElement.dataset.taskId;
                    if(stepId) {
                        // 查找 state 的逻辑需要更健壮，因为 taskId 可能和 stepName 不一样
                        const state = this.executionState.get(stepId) || Array.from(this.executionState.values()).find(s => s.stepName === stepId || s.taskId === stepId);
                        if(state) {
                            state.isCollapsed = !state.isCollapsed;
                            this.render();
                        }
                    }
                }
                // highlight-end
                return;
            }
        });
    }

    private postRender() { /* For future use */ }
}