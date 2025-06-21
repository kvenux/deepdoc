// src/extension/extension.ts (修改后完整文件)

import * as vscode from 'vscode';
import { CodeWikiViewProvider } from './CodeWikiViewProvider';
import { StateManager } from './StateManager';
import { LLMService } from './services/LLMService';
import { AgentService } from './services/AgentService'; // <-- 新的 import

export async function activate(context: vscode.ExtensionContext) {
    // --- 服务初始化 ---
    const stateManager = new StateManager(context.globalState);
    const llmService = new LLMService();
    const agentService = new AgentService(llmService); // <-- 创建 AgentService

    // 获取默认模型并初始化服务
    const modelConfigs = await stateManager.getModelConfigs();
    const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];
    if (defaultConfig) {
        await agentService.initialize(defaultConfig);
    } else {
        console.warn("No default model config found. Agent Service might not function correctly.");
    }
    // --- 结束服务初始化 ---


    const provider = new CodeWikiViewProvider(context.extensionUri, context, agentService); // <-- 注入 AgentService

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeWikiViewProvider.viewType, provider)
    );

    // --- 命令注册 ---
    const generateProjectDocDisposable = vscode.commands.registerCommand('codewiki.generateProjectDocumentation', async () => {
        const modelConfigs = await stateManager.getModelConfigs();
        const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];
            
        if (!defaultConfig) {
            vscode.window.showErrorMessage("No default model configuration found. Please configure a model in the CodeWiki settings.");
            return;
        }

        // 调用变得非常简单
        await agentService.runProjectDocumentation(defaultConfig);
    });
    
    context.subscriptions.push(generateProjectDocDisposable);

    // 移除了旧的 codewiki.runAgent 命令，因为它的逻辑已经被新的架构和Webview触发器所取代。
}

export function deactivate() {}