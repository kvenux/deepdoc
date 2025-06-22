// src/extension/services/logging.ts (修改后完整文件)

import * as vscode from 'vscode';
import { AgentPlan, StepExecution, StepUpdate, StepResult, StreamChunk, AgentResult } from '../../common/types';
import * as path from 'path'; // 引入 path 模块

/**
 * Agent 执行过程中的通用日志记录器接口。
 * 这使得核心逻辑可以与具体的UI（如OutputChannel或Webview）解耦。
 */
export interface AgentLogger {
    info(message: string): void;
    warn(message:string): void;
    error(message: string, error?: Error): void;
    log(message: string): void; // 用于原始输出，如LLM的流式数据
    logLine(message: string): void; // 新增：用于打印带换行的详细日志
    show(preserveFocus?: boolean): void; // 可选，用于显示日志面板

    // --- 新增的结构化事件方法 ---
    onPlanGenerated(plan: AgentPlan): void;
    onStepStart(step: StepExecution): void;
    onStepUpdate(update: StepUpdate): void;
    onStepEnd(result: StepResult): void;
    onStreamChunk(chunk: StreamChunk): void;
    onAgentEnd(result: AgentResult): void;
}

/**
 * AgentLogger接口的一个实现，它将日志写入VS Code的Output Channel。
 */
export class VscodeOutputChannelLogger implements AgentLogger {
    private readonly channel: vscode.OutputChannel;
    private streamBuffer: { [key: string]: string } = {}; // 用于缓存流式数据

    constructor(channelName: string) {
        this.channel = vscode.window.createOutputChannel(channelName);
    }

    public info(message: string): void {
        this.channel.appendLine(`[INFO] ${message}`);
    }

    public warn(message: string): void {
        this.channel.appendLine(`[WARN] ${message}`);
    }

    public error(message: string, error?: Error): void {
        this.channel.appendLine(`[ERROR] ${message}`);
        if (error?.stack) {
            this.channel.appendLine(error.stack);
        }
    }

    public log(message: string): void {
        // 对于原始日志，我们不添加前缀，直接追加
        this.channel.append(message);
    }
    
    public logLine(message: string): void {
        this.channel.appendLine(message);
    }

    public show(preserveFocus: boolean = true): void {
        this.channel.show(preserveFocus);
    }

     /**
     * 新接口方法的优化实现
     */
    public onPlanGenerated(plan: AgentPlan): void {
        this.channel.appendLine(`[PLAN] Agent "${plan.agentName}" is ready.`);
        plan.steps.forEach((step, i) => {
            this.channel.appendLine(`  [Step ${i+1}] ${step.name}: ${step.description}`);
        });
    }

    public onStepStart(step: StepExecution): void {
        const id = step.taskId ? `${step.stepName} (Task: ${step.taskId})` : step.stepName;
        this.channel.appendLine(`\n--- [START] ${id} ---`);
        // 初始化当前任务的流式缓存
        if (step.taskId) {
            this.streamBuffer[step.taskId] = '';
        }
    }
    
    /**
     * 核心修改：对 onStepUpdate 的内容进行审查和简化
     */
    public onStepUpdate(update: StepUpdate): void {
        if (update.type === 'output') {
            // 检查元数据中是否包含文件路径信息
            if (update.metadata?.type === 'file' && typeof update.metadata.path === 'string') {
                // 如果是文件输出，只打印文件名
                const fileName = path.basename(update.metadata.path);
                this.channel.appendLine(`[OUTPUT] Generated file: ${fileName}`);
            } else {
                // 对于其他输出，提取内容并进行长度限制
                let outputStr = '';
                if (typeof update.data === 'object' && update.data !== null && 'content' in update.data) {
                    outputStr = String(update.data.content);
                } else {
                    outputStr = typeof update.data === 'string' ? update.data : JSON.stringify(update.data);
                }
                
                // // 如果内容过长，只打印摘要信息，否则打印完整内容
                // const MAX_LENGTH = 150;
                // if (outputStr.length > MAX_LENGTH) {
                //     this.channel.appendLine(`[OUTPUT] ${outputStr.substring(0, MAX_LENGTH)}... (Content too long)`);
                // } else {
                //     this.channel.appendLine(`[OUTPUT] ${outputStr}`);
                // }
            }
        }
        // 其他类型的 update (input, llm-request) 将被忽略，不打印
    }
    
    /**
     * 核心修改：onStepEnd 不再打印流式缓存，因为 onStreamChunk 已被禁用
     */
    public onStepEnd(result: StepResult): void {
        const id = result.taskId ? `${result.status.toUpperCase()} (Task: ${result.taskId})` : result.status.toUpperCase();
        
        // 如果失败，打印错误信息
        if (result.status === 'failed' && result.error) {
            this.channel.appendLine(`[ERROR] ${result.error}`);
        }
        
        this.channel.appendLine(`--- [${id}] ---`);
        // 不再需要处理 streamBuffer
    }

    /**
     * 核心修改：onStreamChunk 完全禁用，不执行任何操作
     */
    public onStreamChunk(chunk: StreamChunk): void {
        // Do nothing. We don't want to log stream chunks to the output channel.
    }

    public onAgentEnd(result: AgentResult): void {
        this.channel.appendLine(`\n====== [AGENT ${result.status.toUpperCase()}] ======`);
        if(result.error) {
            this.error("Agent failed", new Error(result.error));
        }
    }
}

/**
 * AgentLogger接口的一个实现，它将日志通过postMessage发送到Webview。
 */
export class WebviewLogger implements AgentLogger {
    constructor(private webview: vscode.Webview) {}

    info(message: string): void {
        // 只发送简洁的状态更新
        this.webview.postMessage({ command: 'agentStatusUpdate', payload: { status: 'info', message }});
    }

    warn(message: string): void {
        this.webview.postMessage({ command: 'agentStatusUpdate', payload: { status: 'warn', message }});
    }

    error(message: string, error?: Error): void {
        const errorMessage = error ? `${message}: ${error.message}` : message;
        this.webview.postMessage({ command: 'requestFailed', payload: { error: errorMessage }});
    }

    log(message: string): void {
        // 流式数据有专门的命令
        this.webview.postMessage({ command: 'streamData', payload: message });
    }

    logLine(message: string): void {
        // 对于Webview，一行详细日志可以被视为一个'info'状态
        this.info(message);
    }

    show(preserveFocus?: boolean | undefined): void {
        // Webview 默认就是可见的，此方法可以为空
    }

    // --- 添加新方法的空实现 (TODO for Phase 3) ---
    public onPlanGenerated(plan: AgentPlan): void { /* TODO in Phase 3 */ }
    public onStepStart(step: StepExecution): void { /* TODO in Phase 3 */ }
    public onStepUpdate(update: StepUpdate): void { /* TODO in Phase 3 */ }
    public onStepEnd(result: StepResult): void { /* TODO in Phase 3 */ }
    public onStreamChunk(chunk: StreamChunk): void { 
        // 可以提前实现这个，因为它与现有逻辑相似
        this.webview.postMessage({ command: 'agent:streamChunk', payload: chunk });
    }
    public onAgentEnd(result: AgentResult): void { /* TODO in Phase 3 */ }
}