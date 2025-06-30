// src/extension/extension.ts (修改后完整文件)

import * as vscode from 'vscode';
import { CodeWikiViewProvider } from './CodeWikiViewProvider';
import { StateManager } from './StateManager';
import { LLMService } from './services/LLMService';
import { AgentService } from './services/AgentService';
import { init } from 'tiktoken/init';

/**
 * 检查并确保提示词文件已复制到用户工作区的 .codewiki 目录中。
 * 如果 .codewiki 目录或其中的提示词文件不存在，则会创建它们。
 * @param context 扩展上下文，用于获取插件的安装路径。
 */
async function ensurePromptsAreCopied(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        // 没有打开的工作区，无需执行任何操作
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri;
    const codewikiDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki');
    const sourcePromptsDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'prompts');

    try {
        // 检查 .codewiki 目录是否存在
        await vscode.workspace.fs.stat(codewikiDir);
    } catch (error) {
        // 如果目录不存在 (FileNotFound error)，则创建它
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            console.log("'.codewiki' directory not found. Creating it and copying prompts...");
            await vscode.workspace.fs.createDirectory(codewikiDir);
        } else {
            // 对于其他错误，打印并重新抛出
            console.error("Error checking .codewiki directory:", error);
            throw error;
        }
    }

    // 无论目录是已存在还是刚创建，都检查并复制所有提示词文件
    try {
        const bundledPromptFiles = await vscode.workspace.fs.readDirectory(sourcePromptsDir);
        for (const [fileName, fileType] of bundledPromptFiles) {
            if (fileType === vscode.FileType.File) {
                const sourceUri = vscode.Uri.joinPath(sourcePromptsDir, fileName);
                const targetUri = vscode.Uri.joinPath(codewikiDir, fileName);

                try {
                    // 尝试访问目标文件，如果不存在则会抛出错误
                    await vscode.workspace.fs.stat(targetUri);
                } catch {
                    // 文件不存在，执行复制操作
                    console.log(`Prompt file '${fileName}' not found in .codewiki. Copying...`);
                    await vscode.workspace.fs.copy(sourceUri, targetUri);
                }
            }
        }
    } catch (e) {
        console.error("Failed to copy prompt files:", e);
        vscode.window.showErrorMessage("CodeWiki: Failed to initialize required prompt files. Please try reloading the window.");
    }
}

// --- 新增：tiktoken 初始化函数 ---
async function initializeTiktoken(context: vscode.ExtensionContext): Promise<void> {
    try {
        // 构建 WASM 文件在扩展安装目录中的绝对路径
        const wasmUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'tiktoken_bg.wasm');
        
        // 读取 WASM 文件的二进制内容
        const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);

        // 初始化 tiktoken
        await init((imports) => WebAssembly.instantiate(wasmBytes, imports));
        console.log("tiktoken initialized successfully.");

    } catch (err) {
        console.error("Failed to initialize tiktoken:", err);
        // 这是一个严重错误，可以考虑向用户显示一个错误消息
        vscode.window.showErrorMessage("CodeWiki: Failed to load a critical component (tiktoken). Token counting will not work.");
        // 你可以选择在这里抛出错误，以阻止插件继续加载
        throw err;
    }
}


export async function activate(context: vscode.ExtensionContext) {
    // --- 新增：最先执行 tiktoken 初始化 ---
    await initializeTiktoken(context);

    // --- 新增：在所有服务初始化之前，确保提示词已就绪 ---
    await ensurePromptsAreCopied(context);
    // --------------------------------------------------

    // --- 服务初始化 ---
    const stateManager = new StateManager(context.globalState);
    const llmService = new LLMService();
    const agentService = new AgentService(llmService, stateManager); 

    // 获取默认模型并初始化服务
    const modelConfigs = await stateManager.getModelConfigs();
    const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];
    if (defaultConfig) {
        await agentService.initialize(defaultConfig);
    } else {
        console.warn("No default model config found. Agent Service might not function correctly.");
    }
    // --- 结束服务初始化 ---

    // 首次激活时，也应用一次性能配置
    const perfConfig = await stateManager.getPerformanceConfig();
    llmService.concurrencyLimit = perfConfig.concurrencyLimit;
    llmService.minInterval = perfConfig.minInterval;

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