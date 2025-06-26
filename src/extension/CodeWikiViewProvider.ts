// src/extension/CodeWikiViewProvider.ts (修改后完整文件)

import * as vscode from 'vscode';
import { PostMessage, Conversation, ChatMessage, Prompt, ModelConfig, AgentPlan, TextChatMessage } from '../common/types';
import { StateManager } from './StateManager';
import { LLMService } from './services/LLMService';
import { AgentService } from './services/AgentService';
import { v4 as uuidv4 } from 'uuid';
import * as yaml from 'js-yaml';
import { WebviewLogger } from './services/logging';
import * as path from 'path';

export class CodeWikiViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'codewiki.mainView';

    private _view?: vscode.WebviewView;
    private _focusEditorView?: vscode.WebviewPanel;
    private _stateManager: StateManager;
    private _llmService: LLMService;
    private _agentService: AgentService; // <-- 新增 AgentService 成员
    private _activeConversation: Conversation | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        agentService: AgentService // <-- 注入 AgentService
    ) {
        this._stateManager = new StateManager(this._context.globalState);
        this._llmService = new LLMService();
        this._agentService = agentService; // <-- 保存注入的实例
    }

    // initializeTools 方法被移除，其功能已移至 AgentService 和 ToolRegistry

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,

            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((data: PostMessage) => {
            this.handleMessage(data, 'sidebar');
        });
    }

    private async handleMessage(data: PostMessage, source: 'sidebar' | 'focus-editor' = 'sidebar') {
        const webview = (source === 'sidebar' && data.command.startsWith('agent:'))
            ? this._view?.webview
            : (source === 'focus-editor')
                ? this._focusEditorView?.webview
                : this._view?.webview; // 默认或非 agent 命令使用主视图

        // 对于 Agent 命令，我们强制它必须来自主视图，并检查 webview 是否存在
        if (data.command.startsWith('agent:')) {
            if (!this._view?.webview) {
                console.error("Agent command received but main webview is not available.");
                return;
            }
        }
        const sourceWebview = (source === 'focus-editor') ? this._focusEditorView?.webview : this._view?.webview;

        switch (data.command) {
            case 'ready':
                {
                    const sourceWebview = (source === 'focus-editor') ? this._focusEditorView?.webview : this._view?.webview;
                    if (!sourceWebview) break;

                    const conversations = await this._stateManager.getConversations();
                    const modelConfigs = await this._stateManager.getModelConfigs();
                    const prompts = await this._stateManager.getPrompts();

                    // If there are conversations, set the most recent one as active.
                    if (source === 'sidebar' && conversations.length > 0) {
                        if (!this._activeConversation) { // 避免覆盖已激活的对话
                            this._activeConversation = conversations[conversations.length - 1];
                        }
                    }

                    sourceWebview.postMessage({
                        command: 'initialize',
                        payload: {
                            conversations,
                            modelConfigs,
                            prompts
                        }
                    });
                    break;
                }
            case 'openFocusEditor':
                {
                    const { content, modelId, promptId } = data.payload;
                    if (this._focusEditorView) {
                        this._focusEditorView.reveal(vscode.ViewColumn.One);
                    } else {
                        this._focusEditorView = vscode.window.createWebviewPanel(
                            'codewiki.focusEditor',
                            'Focus Editor',
                            vscode.ViewColumn.One,
                            {
                                enableScripts: true,
                                localResourceRoots: [this._extensionUri]
                            }
                        );

                        this._focusEditorView.webview.html = this._getHtmlForWebview(this._focusEditorView.webview);

                        this._focusEditorView.onDidDispose(() => {
                            this._focusEditorView = undefined;
                            this._view?.webview.postMessage({ command: 'focusEditorClosed' });
                        }, null, this._context.subscriptions);

                        this._focusEditorView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg, 'focus-editor'));
                    }

                    const modelConfigs = await this._stateManager.getModelConfigs();
                    const prompts = await this._stateManager.getPrompts();

                    // 将所有需要的数据一次性发送过去
                    this._focusEditorView.webview.postMessage({
                        command: 'showFocusEditor',
                        payload: {
                            content,
                            modelId,
                            promptId,
                            modelConfigs, // 捆绑模型数据
                            prompts       // 捆绑提示词数据
                        }
                    });
                    break;
                }
            case 'closeFocusEditor':
                {
                    this._focusEditorView?.dispose();
                    break;
                }
            case 'updateWebviewContent':
                {
                    const { content } = data.payload;
                    if (source === 'sidebar') {
                        this._focusEditorView?.webview.postMessage({ command: 'updateContent', payload: { content } });
                    } else { // source === 'focus-editor'
                        this._view?.webview.postMessage({ command: 'updateContent', payload: { content } });
                    }
                    break;
                }
            case 'syncStateChange':
                {
                    if (source === 'sidebar') {
                        this._focusEditorView?.webview.postMessage({ command: 'updateState', payload: data.payload });
                    } else { // source === 'focus-editor'
                        this._view?.webview.postMessage({ command: 'updateState', payload: data.payload });
                    }
                    break;
                }
            case 'newChat':
                {
                    this._activeConversation = null;
                    // Potentially clear the webview chat here if needed
                    break;
                }
            case 'info':
                {
                    vscode.window.showInformationMessage(data.payload);
                    break;
                }
            case 'error':
                {
                    vscode.window.showErrorMessage(data.payload);
                    break;
                }
            
            case 'saveConversation': // 新增 case 处理来自 webview 的保存请求
                {
                    const { id, messages } = data.payload;
                    const allConversations = await this._stateManager.getConversations();
                    const conversationToUpdate = allConversations.find(c => c.id === id);
                    if (conversationToUpdate) {
                        conversationToUpdate.messages = messages;
                        await this._stateManager.saveConversation(conversationToUpdate);
                        // 更新内存中的活动对话
                        if (this._activeConversation && this._activeConversation.id === id) {
                            this._activeConversation = conversationToUpdate;
                        }
                    }
                    break;
                }
            
            case 'sendMessage':
                {
                    // When a message is sent from either view, clear the input in the other.
                    if (source === 'sidebar') {
                        this._focusEditorView?.webview.postMessage({ command: 'clearInput' });
                    } else {
                        this._view?.webview.postMessage({ command: 'clearInput' });
                    }

                    const { prompt, config } = data.payload;
                    
                    const userMessage: TextChatMessage = { type: 'text', role: 'user', content: prompt };
                    let modelMessage: TextChatMessage = { type: 'text', role: 'assistant', content: '' };
                    

                    // Ensure there is an active conversation
                    if (!this._activeConversation) {
                        this._activeConversation = {
                            id: uuidv4(),
                            title: prompt.substring(0, 50), // Add title
                            messages: [],
                            createdAt: new Date().toISOString(),
                        };
                         
                        // 首次消息，需要将整个新对话保存起来
                        this._activeConversation.messages.push(userMessage);
                        await this._stateManager.saveConversation(this._activeConversation);
                         
                    } else {
                        this._activeConversation.messages.push(userMessage);
                    }


                    // Tell the webviews to enter streaming state
                    this._view?.webview.postMessage({ command: 'startStreaming' });
                    this._focusEditorView?.webview.postMessage({ command: 'startStreaming' });


                    let fullReply = '';
                    this._llmService.getCompletion(
                        this._activeConversation.messages,
                        config,
                        (chunk: string) => { 
                            fullReply += chunk;
                            this._view?.webview.postMessage({ command: 'streamData', payload: chunk });
                            this._focusEditorView?.webview.postMessage({ command: 'streamData', payload: chunk });
                        },
                        async () => {
                            modelMessage.content = fullReply;
                            // Ensure we have an active conversation before proceeding
                            if (this._activeConversation) {
                                this._activeConversation.messages.push(modelMessage);
                                await this._stateManager.saveConversation(this._activeConversation);
                            }
                            
                            // Tell both webviews to end streaming state
                            this._view?.webview.postMessage({ command: 'streamEnd' });
                            this._focusEditorView?.webview.postMessage({ command: 'streamEnd' });
                        
                            // Update history view in case a new conversation was created
                            const conversations = await this._stateManager.getConversations();
                            this._view?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                        },
                        (error: any) => { 
                            const errorPayload = { error: error.message };
                            this._view?.webview.postMessage({ command: 'requestFailed', payload: errorPayload });
                            this._focusEditorView?.webview.postMessage({ command: 'requestFailed', payload: errorPayload });
                        }
                    );
                    break;
                }
            case 'stopMessage':
                {
                    this._llmService.abortRequest();
                    break;
                }
            case 'executeActionPrompt':
                {
                    const webview = this._view?.webview;
                    if (!webview) return;

                    const { yamlContent, userInputs, modelConfig } = data.payload;

                    // 启动流式处理的UI状态
                    webview.postMessage({ command: 'startStreaming' });

                    // 将所有复杂性委托给 AgentService
                    // AgentService 内部会创建 WebviewLogger 来发送状态更新、流式数据和错误
                    await this._agentService.runActionFromWebview(
                        yamlContent,
                        userInputs,
                        modelConfig,
                        webview
                    );

                    // AgentService 完成后，结束流式UI状态
                    webview.postMessage({ command: 'streamEnd' });

                    break;
                }
            case 'regenerate':
            case 'editMessage':
                {
                    if (!this._activeConversation) break;

                    const { messageIndex, content } = data.payload;

                    // Truncate the history to the point of regeneration/edit
                    this._activeConversation.messages.splice(messageIndex);

                    if (data.command === 'editMessage') {
                        
                        const userMessage: TextChatMessage = { type: 'text', role: 'user', content: content };
                        
                        this._activeConversation.messages.push(userMessage);
                    }

                    // Find the last valid model config from the conversation
                    const modelConfigs = await this._stateManager.getModelConfigs();
                    const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];

                    if (!defaultConfig) {
                        vscode.window.showErrorMessage('No model configured.');
                        break;
                    }

                    
                    let modelMessage: TextChatMessage = { type: 'text', role: 'assistant', content: '' };
                    
                    let fullReply = '';

                    // Post a message to clear the old response and show a loading state
                    this._view?.webview.postMessage({ command: 'setActiveConversation', payload: this._activeConversation });
                    // Tell the webview to enter streaming state
                    this._view?.webview.postMessage({ command: 'startStreaming' });

                    this._llmService.getCompletion(
                        this._activeConversation.messages,
                        defaultConfig,
                        (chunk: string) => { 
                            fullReply += chunk;
                            this._view?.webview.postMessage({ command: 'streamData', payload: chunk });
                        },
                        async () => {
                            modelMessage.content = fullReply;
                            if (this._activeConversation) {
                                this._activeConversation.messages.push(modelMessage);
                                await this._stateManager.saveConversation(this._activeConversation);
                            }
                        
                            // Tell the main webview to end streaming state
                            this._view?.webview.postMessage({ command: 'streamEnd' });
                        
                            // Update history view
                            const conversations = await this._stateManager.getConversations();
                            this._view?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                        },
                        (error: any) => { 
                            this._view?.webview.postMessage({ command: 'requestFailed', payload: { error: error.message } });
                        }
                    );
                    break;
                }
            case 'loadConversation':
                {
                    const { id } = data.payload;
                    const conversations = await this._stateManager.getConversations();
                    const conversation = conversations.find(c => c.id === id);
                    if (conversation) {
                        this._activeConversation = conversation;
                        this._view?.webview.postMessage({ command: 'setActiveConversation', payload: conversation });
                    }
                    break;
                }
            case 'deleteConversation':
                {
                    const { id } = data.payload;
                    await this._stateManager.deleteConversation(id);
                    const conversations = await this._stateManager.getConversations();
                    this._view?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                    // If the deleted conversation was active, clear the chat view
                    if (this._activeConversation && this._activeConversation.id === id) {
                        this._activeConversation = null;
                        this._view?.webview.postMessage({ command: 'setActiveConversation', payload: null });
                    }
                    break;
                }
            case 'saveModelConfigs':
                {
                    await this._stateManager.saveModelConfigs(data.payload);
                    vscode.window.showInformationMessage('Model configurations saved.');

                    // 广播模型配置更新到所有视图
                    const updateMessage = {
                        command: 'updateModelConfigs',
                        payload: data.payload
                    };
                    this._view?.webview.postMessage(updateMessage);
                    this._focusEditorView?.webview.postMessage(updateMessage);

                    // Re-initialize agent service with the new default model
                    const defaultConfig = data.payload.find((c: ModelConfig) => c.isDefault) || (data.payload.length > 0 ? data.payload[0] : null);
                    if (defaultConfig) {
                        await this._agentService.initialize(defaultConfig);
                        console.log("AgentService re-initialized with new default model.");
                    } else {
                        console.warn("No default model config found after saving. Agent Service might not function correctly.");
                    }
                    break;
                }
            //== Prompt Management ==//
            case 'newPrompt':
                {
                    this._view?.webview.postMessage({ command: 'showPromptEditor' });
                    break;
                }
            case 'editPrompt':
                {
                    const { id } = data.payload;
                    const prompts = await this._stateManager.getPrompts();
                    const prompt = prompts.find(p => p.id === id);
                    if (prompt) {
                        this._view?.webview.postMessage({ command: 'showPromptEditor', payload: { prompt } });
                    }
                    break;
                }
            case 'savePrompt':
                {
                    const prompt: Prompt = data.payload;
                    await this._stateManager.savePrompt(prompt);
                    vscode.window.showInformationMessage(`Prompt "${prompt.title}" saved.`);
                    // First, update the prompts list in the webview
                    await this._updatePrompts();
                    // Then, tell the webview to navigate back to the manager
                    this._view?.webview.postMessage({ command: 'showPromptManager' });
                    break;
                }
            case 'cancelPromptEdit':
                {
                    this._view?.webview.postMessage({ command: 'showPromptManager' });
                    break;
                }
            case 'deletePrompt':
                {
                    const { id } = data.payload;
                    // Optional: Add a confirmation dialog
                    const confirmation = await vscode.window.showWarningMessage(
                        'Are you sure you want to delete this prompt?',
                        { modal: true },
                        'Delete'
                    );
                    if (confirmation === 'Delete') {
                        await this._stateManager.deletePrompt(id);
                        await this._updatePrompts();
                        vscode.window.showInformationMessage('Prompt deleted.');
                    }
                    break;
                }
            case 'agent:getPlan': {
                // 确保 webview 存在，agent 命令只在主视图处理
                const mainWebview = this._view?.webview;
                if (!mainWebview) break;

                const { agentId } = data.payload;
                const plan = this._agentService.getAgentPlan(agentId);
                if (plan) {
                    const logger = new WebviewLogger(mainWebview);
                    logger.onPlanGenerated(plan);
                } else {
                    vscode.window.showErrorMessage(`Agent with ID "${agentId}" could not be found.`);
                }
                break;
            }

            case 'agent:execute': {
                // 确保 webview 存在
                const mainWebview = this._view?.webview;
                if (!mainWebview) break;

                const { agentId, parameters } = data.payload;

                const modelConfigs = await this._stateManager.getModelConfigs();
                const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];
                if (!defaultConfig) {
                    const errorMsg = 'No default model configured. Please set one in the settings.';
                    vscode.window.showErrorMessage(errorMsg);
                    const logger = new WebviewLogger(mainWebview);
                    logger.onAgentEnd({ runId: 'init-fail', status: 'failed', error: errorMsg });
                    return;
                }
                
                // 如果当前没有激活的对话，则创建一个新的
                if (!this._activeConversation) {
                    const agentPlan = this._agentService.getAgentPlan(agentId);
                    this._activeConversation = {
                        id: uuidv4(),
                        title: `Agent Run: ${agentPlan?.agentName || agentId}`,
                        messages: [],
                        createdAt: new Date().toISOString(),
                    };
                    await this._stateManager.saveConversation(this._activeConversation);
                    // 通知 webview 更新历史记录
                    const conversations = await this._stateManager.getConversations();
                    this._view?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                    this._view?.webview.postMessage({ command: 'setActiveConversation', payload: this._activeConversation });
                }
                

                const logger = new WebviewLogger(mainWebview);

                // 异步执行 Agent
                this._agentService.prepareAndRunAgent(
                    agentId,
                    parameters,
                    defaultConfig,
                    logger
                );
                break;
            }

            case 'agent:cancel': {
                const { runId } = data.payload;
                if (runId) {
                    await this._agentService.cancelAgentRun(runId);
                }
                break;
            }

            case 'viewFile': {
                const filePathPayload = data.payload?.path;
                if (typeof filePathPayload === 'string') {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const workspaceRootUri = workspaceFolders[0].uri;
                        let fileToOpenUri: vscode.Uri;

                        // 检查 filePathPayload 是否已经是绝对路径 (虽然通常 webview 发送的是相对路径或特殊标记的路径)
                        // 或者是否是相对于 .codewiki/runs/... 的路径
                        if (path.isAbsolute(filePathPayload)) {
                            fileToOpenUri = vscode.Uri.file(filePathPayload);
                        } else if (filePathPayload.startsWith('.codewiki/') || filePathPayload.startsWith('.vscode/')) {
                            // 假设路径是相对于工作区根目录的，例如从 .codewiki 目录
                            fileToOpenUri = vscode.Uri.joinPath(workspaceRootUri, filePathPayload);
                        } else {
                            // 默认行为：如果不是 .codewiki/runs/... 下的，尝试把它作为相对于 .codewiki 目录下的提示文件
                            // (这可能需要调整，取决于 fileCard 的 filePath 具体是什么)
                            // 假设它可能是 .codewiki 目录下的 yml 文件
                            // 如果是 Agent 运行产生的 markdown 文件，路径可能需要特别处理
                            // 例如，AgentResult 的 finalOutput 可能是 "项目总体设计文档.md"
                            // 这时需要结合 Agent 运行的 runDir 来构造完整路径

                            // 对于 AgentPlan 中的 promptFiles (e.g., 'project_planner.yml')
                            // 它们是相对于 .codewiki 目录的
                            if (filePathPayload.endsWith('.yml') || filePathPayload.endsWith('.yaml')) {
                                fileToOpenUri = vscode.Uri.joinPath(workspaceRootUri, '.codewiki', filePathPayload);
                            } else if (filePathPayload.endsWith('.md') && this._agentService && (this._agentService as any).getLastRunDir) {
                                // 这是一个假设：AgentService 能提供上次运行的目录
                                // 这个逻辑比较复杂，因为 CodeWikiViewProvider 通常不知道 runDir
                                // 更好的做法是让 AgentRunBlock 发送更明确的路径类型或完整路径
                                // 或者，AgentResult.finalOutput 如果是文件，应该是相对于工作区的路径
                                const lastRunDir = await (this._agentService as any).getLastRunDir(); // 需要 AgentService 支持
                                if (lastRunDir) {
                                    fileToOpenUri = vscode.Uri.joinPath(lastRunDir, filePathPayload);
                                } else {
                                    vscode.window.showErrorMessage(`无法确定文件 ${filePathPayload} 的完整路径。`);
                                    return;
                                }
                            }
                            else {
                                // 默认尝试作为项目根路径下的文件
                                fileToOpenUri = vscode.Uri.joinPath(workspaceRootUri, filePathPayload);
                            }
                        }

                        try {
                            // 检查文件是否存在
                            await vscode.workspace.fs.stat(fileToOpenUri);
                            vscode.window.showTextDocument(fileToOpenUri);
                        } catch (error) {
                            console.error(`Error opening file ${fileToOpenUri.fsPath}:`, error);
                            // 如果 .codewiki/xxx.yml 不存在，尝试作为项目根目录下的文件
                            if ((filePathPayload.endsWith('.yml') || filePathPayload.endsWith('.yaml')) && !filePathPayload.includes('/')) {
                                try {
                                    const rootFileUri = vscode.Uri.joinPath(workspaceRootUri, filePathPayload);
                                    await vscode.workspace.fs.stat(rootFileUri);
                                    vscode.window.showTextDocument(rootFileUri);
                                    return;
                                } catch (rootError) {
                                    vscode.window.showErrorMessage(`文件 "${filePathPayload}" 未在 .codewiki/ 或项目根目录中找到。`);
                                }
                            } else {
                                vscode.window.showErrorMessage(`无法打开文件: ${filePathPayload}. 文件可能不存在或路径不正确。`);
                            }
                        }
                    } else {
                        vscode.window.showWarningMessage('请先打开一个工作区以查看文件。');
                    }
                } else {
                    vscode.window.showErrorMessage('无效的文件路径。');
                }
                break;
            }
        }
    }

    private async _updatePrompts() {
        const prompts = await this._stateManager.getPrompts();
        const updateMessage = { command: 'updatePrompts', payload: prompts };
        this._view?.webview.postMessage(updateMessage);
        this._focusEditorView?.webview.postMessage(updateMessage);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'css', 'main.css'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                
                <link href="${codiconsUri}" rel="stylesheet" />
                <link href="${styleUri}" rel="stylesheet" />
                
                <title>CodeWiki</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}