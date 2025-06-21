// src/extension/services/logging.ts (修改后完整文件)

import * as vscode from 'vscode';

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
}

/**
 * AgentLogger接口的一个实现，它将日志写入VS Code的Output Channel。
 */
export class VscodeOutputChannelLogger implements AgentLogger {
    private readonly channel: vscode.OutputChannel;

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
}