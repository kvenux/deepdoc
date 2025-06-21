// src/extension/CodeWikiViewProvider.ts (修改后完整文件)

import * as vscode from 'vscode';
import { PostMessage, Conversation, ChatMessage, Prompt, ModelConfig } from '../common/types';
import { StateManager } from './StateManager';
import { LLMService } from './services/LLMService';
import { AgentService } from './services/AgentService'; // <-- 引入新的 AgentService
import { v4 as uuidv4 } from 'uuid';
import * as yaml from 'js-yaml'; // js-yaml 仍然需要，但仅用于其他可能的YAML处理

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
            case 'sendMessage':
                {
                    // When a message is sent from either view, clear the input in the other.
                    if (source === 'sidebar') {
                        this._focusEditorView?.webview.postMessage({ command: 'clearInput' });
                    } else {
                        this._view?.webview.postMessage({ command: 'clearInput' });
                    }

                    const { prompt, config } = data.payload;
                    const userMessage: ChatMessage = { role: 'user', content: prompt };
                    let modelMessage: ChatMessage = { role: 'assistant', content: '' };

                    // Ensure there is an active conversation
                    if (!this._activeConversation) {
                        this._activeConversation = {
                            id: uuidv4(),
                            title: prompt.substring(0, 50), // Add title
                            messages: [],
                            createdAt: new Date().toISOString(),
                        };
                    }

                    this._activeConversation.messages.push(userMessage);

                    // Tell the webviews to enter streaming state
                    this._view?.webview.postMessage({ command: 'startStreaming' });
                    this._focusEditorView?.webview.postMessage({ command: 'startStreaming' });


                    let fullReply = '';
                    this._llmService.getCompletion(
                        this._activeConversation.messages,
                        config,
                        (chunk: string) => { // <--- 添加类型 : string
                            fullReply += chunk;
                            this._view?.webview.postMessage({ command: 'streamData', payload: chunk });
                            this._focusEditorView?.webview.postMessage({ command: 'streamData', payload: chunk });
                        },
                        async () => {
                            // ...
                        },
                        (error: any) => { // <--- 添加类型 : any 或 : Error
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
                        const userMessage: ChatMessage = { role: 'user', content: content };
                        this._activeConversation.messages.push(userMessage);
                    }

                    // Find the last valid model config from the conversation
                    const modelConfigs = await this._stateManager.getModelConfigs();
                    const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];

                    if (!defaultConfig) {
                        vscode.window.showErrorMessage('No model configured.');
                        break;
                    }

                    let modelMessage: ChatMessage = { role: 'assistant', content: '' };
                    let fullReply = '';

                    // Post a message to clear the old response and show a loading state
                    this._view?.webview.postMessage({ command: 'setActiveConversation', payload: this._activeConversation });
                    // Tell the webview to enter streaming state
                    this._view?.webview.postMessage({ command: 'startStreaming' });

                    this._llmService.getCompletion(
                        this._activeConversation.messages,
                        defaultConfig,
                        (chunk: string) => { // <--- 添加类型 : string
                            fullReply += chunk;
                            this._view?.webview.postMessage({ command: 'streamData', payload: chunk });
                        },
                        async () => {
                            // ...
                        },
                        (error: any) => { // <--- 添加类型 : any 或 : Error
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