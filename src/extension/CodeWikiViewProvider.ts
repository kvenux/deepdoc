// src/extension/CodeWikiViewProvider.ts (在顶部添加)

import * as vscode from 'vscode';
import { PostMessage, Conversation, ChatMessage, Prompt } from '../common/types';
import { StateManager } from './StateManager';
import { LLMService } from './LLMService';
import { v4 as uuidv4 } from 'uuid';


// 导入 YAML 解析器
import * as yaml from 'js-yaml';
// 导入新的工具
import { GetFileSummariesTool, GetFilesContentByListTool } from './tools/fileSystemTools';
import { createFileSelectorLLMTool } from './tools/llmTools';
// 导入我们的执行器和相关类型
import { CustomAgentExecutor, ToolChainStep, LlmPromptTemplate, AgentExecutorCallbacks } from './agents/CustomAgentExecutor';
// 导入 LangChain 相关类
import { ChatOpenAI } from '@langchain/openai';
import { StructuredTool } from '@langchain/core/tools';

export class CodeWikiViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'codewiki.mainView';

    private _view?: vscode.WebviewView;
    private _focusEditorView?: vscode.WebviewPanel;
    private _stateManager: StateManager;
    private _llmService: LLMService;
    private _activeConversation: Conversation | null = null;
    private _tools: StructuredTool[];
    private _agentExecutor: CustomAgentExecutor | null = null;


    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._stateManager = new StateManager(this._context.globalState);
        this._llmService = new LLMService();
        this._tools = []; // 初始化为空数组
        this.initializeTools();
    }

    private async initializeTools() {
        // 创建一个临时的 LLM 实例，仅用于初始化 LLM-as-a-Tool
        // Agent 执行时会根据当前配置动态创建新的 LLM 实例
        const modelConfigs = await this._stateManager.getModelConfigs();
        const defaultModelConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];

        if (defaultModelConfig) {
            const toolLlm = new ChatOpenAI({
                modelName: defaultModelConfig.modelId,
                apiKey: defaultModelConfig.apiKey,
                configuration: { baseURL: defaultModelConfig.baseUrl },
                temperature: 0.1, // 工具型LLM温度可以低一些
            });

            this._tools = [
                new GetFileSummariesTool(),
                new GetFilesContentByListTool(),
                createFileSelectorLLMTool(toolLlm),
            ];

            this._agentExecutor = new CustomAgentExecutor(this._tools, toolLlm); // 这里的llm只是个占位，运行时会用新的
        } else {
            this._tools = [
                new GetFileSummariesTool(),
                new GetFilesContentByListTool(),
            ];
            console.warn("No default model config found. LLM-based tools will not be available.");
        }
    }

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
                        (chunk) => {
                            fullReply += chunk;
                            this._view?.webview.postMessage({ command: 'streamData', payload: chunk });
                            this._focusEditorView?.webview.postMessage({ command: 'streamData', payload: chunk });
                        },
                        async () => {
                            modelMessage.content = fullReply;
                            if (this._activeConversation) {
                                this._activeConversation.messages.push(modelMessage);
                                await this._stateManager.saveConversation(this._activeConversation);
                                // After saving, just update the history, don't reload the whole conversation
                                const conversations = await this._stateManager.getConversations();
                                this._view?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                                this._focusEditorView?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                            }
                            this._view?.webview.postMessage({ command: 'streamEnd' });
                            this._focusEditorView?.webview.postMessage({ command: 'streamEnd' });
                        },
                        (error) => {
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
                    if (!this._agentExecutor) {
                        vscode.window.showErrorMessage("Agent Executor is not initialized. Please configure a model in settings.");
                        return;
                    }

                    const { yamlContent, userInputs, modelConfig } = data.payload;

                    try {
                        const actionPrompt = yaml.load(yamlContent) as {
                            tool_chain: ToolChainStep[];
                            llm_prompt_template: LlmPromptTemplate;
                        };

                        if (!actionPrompt.tool_chain || !actionPrompt.llm_prompt_template) {
                            throw new Error("Invalid Action Prompt YAML format. Missing 'tool_chain' or 'llm_prompt_template'.");
                        }

                        // 根据用户在UI上选择的模型配置，动态创建LLM实例
                        const finalLlm = new ChatOpenAI({
                            modelName: modelConfig.modelId,
                            apiKey: modelConfig.apiKey,
                            streaming: true,
                            temperature: 0.7,
                            configuration: { baseURL: modelConfig.baseUrl },
                        });

                        // 注意：我们需要重新配置 Agent Executor，使其使用最新的 LLM
                        this._agentExecutor = new CustomAgentExecutor(this._tools, finalLlm);

                        const webview = this._view?.webview;
                        if (!webview) return;

                        // 定义回调函数，将 Agent 的执行过程实时发送到前端
                        const callbacks: AgentExecutorCallbacks = {
                            onToolStart: (toolName, input) => {
                                webview.postMessage({ command: 'agentStatusUpdate', payload: { status: 'tool_start', toolName, input: JSON.stringify(input, null, 2) } });
                            },
                            onToolEnd: (toolName, output) => {
                                webview.postMessage({ command: 'agentStatusUpdate', payload: { status: 'tool_end', toolName, output } });
                            },
                            onLlmStart: () => {
                                webview.postMessage({ command: 'startStreaming' }); // 复用已有的流式开始命令
                            },
                            onLlmStream: (chunk) => {
                                webview.postMessage({ command: 'streamData', payload: chunk }); // 复用已有的流式数据命令
                            },
                            onLlmEnd: () => {
                                webview.postMessage({ command: 'streamEnd' }); // 复用已有的流式结束命令
                            },
                            onError: (error) => {
                                webview.postMessage({ command: 'requestFailed', payload: { error: error.message } });
                            }
                        };

                        // 启动 Agent Executor
                        this._agentExecutor.run(
                            actionPrompt.tool_chain,
                            userInputs,
                            actionPrompt.llm_prompt_template,
                            callbacks
                        );

                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Failed to execute action prompt: ${error.message}`);
                        this._view?.webview.postMessage({ command: 'requestFailed', payload: { error: error.message } });
                    }
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
                    const lastUserMessage = this._activeConversation.messages[this._activeConversation.messages.length - 1];
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
                        (chunk) => {
                            fullReply += chunk;
                            this._view?.webview.postMessage({ command: 'streamData', payload: chunk });
                        },
                        async () => {
                            modelMessage.content = fullReply;
                            if (this._activeConversation) {
                                this._activeConversation.messages.push(modelMessage);
                                await this._stateManager.saveConversation(this._activeConversation);
                                const conversations = await this._stateManager.getConversations();
                                this._view?.webview.postMessage({ command: 'updateHistory', payload: conversations });
                            }
                            this._view?.webview.postMessage({ command: 'streamEnd' });
                        },
                        (error) => {
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
                    this._view?.webview.postMessage({
                        command: 'updateModelConfigs',
                        payload: data.payload
                    });
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
        this._view?.webview.postMessage({ command: 'updatePrompts', payload: prompts });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'css', 'main.css'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

        // Use a nonce to only allow specific scripts to be run
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
