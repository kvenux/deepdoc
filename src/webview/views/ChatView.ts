// --- file_path: webview/views/ChatView.ts ---

import { vscode } from "../vscode";
import { MessageBlock } from "../components/MessageBlock";
import { AtCommandMenu } from "../components/AtCommandMenu";
// 在文件顶部添加新的 import
import { AgentRunBlock } from "../components/AgentRunBlock";
import { Conversation, ChatMessage, ModelConfig, Prompt, AgentPlan, StepExecution, StepUpdate, StepResult, StreamChunk, AgentResult, TextChatMessage, AgentRunChatMessage, AgentRunRecord } from "../../common/types";

interface CommandLeaf {
    id: string;
    name: string;
    agentId: string;
    description: string;
}

export class ChatView {
    private activeConversationId: string | null = null;
    private messages: ChatMessage[] = [];
    private modelConfigs: ModelConfig[] = [];
    private prompts: Prompt[] = [];
    private messageContainer: HTMLElement;
    private bottomPanel: HTMLElement;
    private modelSelector: HTMLSelectElement;
    private promptSelector: HTMLSelectElement;
    private isStreaming: boolean = false;
    private editingMessageIndex: number | null = null;
    private originalMessageContent: string | null = null;
    private atCommandMenu: AtCommandMenu;
    private inputBox: HTMLElement; // 从 HTMLTextAreaElement 改为 HTMLElement
    private activeAgentRunContainer: HTMLElement | null = null;
    private activeAgentRunBlock: AgentRunBlock | null = null;
    private isAgentRunning: boolean = false;
    private activeAgentRunId: string | null = null;


    constructor(private readonly parent: HTMLElement) {
        this.parent.innerHTML = this.renderInitialLayout();
        this.messageContainer = this.parent.querySelector('.messages-list') as HTMLElement;
        this.bottomPanel = this.parent.querySelector('.chat-sticky-bottom') as HTMLElement;
        this.modelSelector = this.parent.querySelector('#model-selector') as HTMLSelectElement;
        this.promptSelector = this.parent.querySelector('#prompt-selector') as HTMLSelectElement;

        // 渲染输入框并获取其引用
        this.renderBottomInput(); 
        this.inputBox = this.bottomPanel.querySelector('.chat-input-box') as HTMLElement;
        
        // 将菜单附加到 chat-container, 以便使用相对定位
        const commandMenuContainer = this.parent.querySelector('.at-command-menu-container') as HTMLElement;
        this.atCommandMenu = new AtCommandMenu(commandMenuContainer);

        this.setupEventListeners();
    }

    public setConversations(conversations: Conversation[]) {
        if (conversations.length > 0) {
            // 找到最后一个非空对话
            const lastNonEmptyConversation = [...conversations].reverse().find(c => c.messages.length > 0);
            if (lastNonEmptyConversation) {
                this.messages = lastNonEmptyConversation.messages;
                this.activeConversationId = lastNonEmptyConversation.id;
            } else {
                // 如果所有对话都是空的，则清空当前状态
                this.messages = [];
                this.activeConversationId = null;
            }
        } else {
            this.messages = [];
        }
        this.renderMessages();
    }

    public clearChat() {
        this.messages = [];
        this.renderMessages();
        vscode.postMessage({ command: 'newChat' });
    }

    public loadConversation(conversation: Conversation) {
        this.messages = conversation.messages;
        this.activeConversationId = conversation.id; // 确保加载对话时也设置 activeConversationId
        this.handleCancelEdit(); // Ensure we exit any edit mode when loading a new conversation
        this.renderMessages();
    }

    public setModelConfigs(configs: ModelConfig[]) {
        this.modelConfigs = configs;
        this.renderModelSelector();
    }

    public setPrompts(prompts: Prompt[]) {
        this.prompts = prompts;
        this.renderPromptSelector();
    }

    private setupEventListeners() {
        // Listener for all clicks in the view
        this.parent.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const button = target.closest('button');

            // 如果点击了输入框外部，且@菜单是可见的，则隐藏它
            if (!this.inputBox.contains(target) && !this.atCommandMenu['element'].contains(target)) {
                this.atCommandMenu.hide();
            }

            if (this.editingMessageIndex !== null) {
                const editingBlock = this.parent.querySelector('.message-block.editing');
                if (editingBlock && !editingBlock.contains(target) && !this.bottomPanel.contains(target)) {
                    this.handleCancelEdit();
                    return;
                }
            }

            if (!button) return;
            const action = button.dataset.action;
            if (!action) return;

            const messageBlock = target.closest('.message-block');
            const messageIndex = messageBlock ? parseInt((messageBlock as HTMLElement).dataset.index || '-1', 10) : -1;

            switch (action) {
                case 'send-or-save': this.handleSendOrSave(); break;
                case 'copy-content': if (messageIndex !== -1) this.handleCopy(messageIndex); break;
                case 'regenerate-response': if (messageIndex !== -1) this.handleRegenerate(messageIndex); break;
                case 'edit-message': if (messageIndex !== -1) this.handleEnterEditMode(messageIndex); break;
                case 'maximize-editor': this.handleMaximizeEditor(); break;
                case 'toggle-fold':
                    if (messageBlock) {
                        const icon = button.querySelector('i');
                        messageBlock.classList.toggle('folded');
                        if (messageBlock.classList.contains('folded')) {
                            button.title = 'Expand';
                            icon?.classList.remove('codicon-chevron-up');
                            icon?.classList.add('codicon-chevron-down');
                        } else {
                            button.title = 'Fold';
                            icon?.classList.remove('codicon-chevron-down');
                            icon?.classList.add('codicon-chevron-up');
                        }
                    }
                    break;

            }
        });

        window.addEventListener('resize', () => {

        });

        this.modelSelector.addEventListener('change', () => {
            vscode.postMessage({
                command: 'syncStateChange',
                payload: { modelId: this.modelSelector.value }
            });
        });

        this.promptSelector.addEventListener('change', () => {
            const selectedPromptId = this.promptSelector.value;
            vscode.postMessage({
                command: 'syncStateChange',
                payload: { promptId: selectedPromptId }
            });

            if (selectedPromptId) {
                const selectedPrompt = this.prompts.find(p => p.id === selectedPromptId);
                if (selectedPrompt) {
                    // 更新为操作 contenteditable div
                    if (this.inputBox) {
                        this.inputBox.innerText = selectedPrompt.content;
                        this.inputBox.focus();
                        vscode.postMessage({
                            command: 'updateWebviewContent',
                            payload: { content: this.inputBox.innerText }
                        });
                    }
                }
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            const { command, payload } = message;
            if (command.startsWith('agent:')) {
                if (command === 'agent:planGenerated' && this.activeAgentRunContainer) {
                    const plan: AgentPlan = payload;
                    const onExecute = (params: Record<string, any>) => {
                        vscode.postMessage({
                            command: 'agent:execute',
                            payload: { agentId: plan.agentId, parameters: params }
                        });
                    };
                    this.activeAgentRunBlock = new AgentRunBlock(this.activeAgentRunContainer, plan, onExecute);
                    return;
                }
                
                if (this.activeAgentRunBlock) {
                    switch (command) {
                        case 'agent:stepStart':
                            if (!this.isAgentRunning) { // 第一个步骤事件，标志着运行开始
                                this.isAgentRunning = true;
                                this.activeAgentRunId = payload.runId;
                                this.updateSendButtonState();
                            }
                            this.activeAgentRunBlock.updateStepExecutionStatus(payload as StepExecution);
                            return;
                        case 'agent:stepEnd':
                            this.activeAgentRunBlock.updateStepExecutionStatus(payload as StepResult);
                            return;
                        case 'agent:stepUpdate':
                            this.activeAgentRunBlock.addStepLog(payload);
                            return;
                        case 'agent:streamChunk':
                            this.activeAgentRunBlock.appendStreamChunk(payload);
                            return;
                        case 'agent:end': { // 使用块作用域
                            this.activeAgentRunBlock.setAgentResult(payload as AgentResult);
                            
                            // 对于任何终端状态，都获取其可序列化状态
                            const runRecord = this.activeAgentRunBlock.getSerializableState();

                            if (runRecord) {
                                // --- highlight-start ---
                                // 在保存前截断长字符串
                                const truncatedRecord = this.truncateLongStrings(runRecord);
                                // --- highlight-end ---

                                const agentMessage: AgentRunChatMessage = {
                                    type: 'agent_run',
                                    role: 'assistant',
                                    run: truncatedRecord as AgentRunRecord // 使用截断后的记录
                                };
                                // 将持久化消息添加到历史记录中
                                this.messages.push(agentMessage);
                                this.saveCurrentConversation();
                            }

                            // 清理实时运行状态
                            this.isAgentRunning = false;
                            this.activeAgentRunId = null;
                            this.activeAgentRunBlock = null; 
                            this.activeAgentRunContainer = null;
                            
                            // 从更新后的 messages 数组中重新渲染整个消息列表。
                            // 这将移除旧的“实时”agent block容器，并从保存的消息中
                            // 渲染一个新的、历史性的 AgentRunBlock。
                            this.renderMessages();
                            
                            this.updateSendButtonState();

                            return;
                        }
                    }
                }
            }

            switch (message.command) {
                case 'startStreaming': this.beginStream(); break;
                case 'streamData': this.appendStreamData(message.payload); break;
                case 'streamEnd': this.finalizeStream(); break;
                case 'requestFailed': this.handleRequestFailed(message.payload.error); break;
                case 'setActiveConversation': this.loadConversation(message.payload); break;
                case 'updatePrompts': this.setPrompts(message.payload); break;
                case 'updateContent': {
                    if (this.inputBox && this.inputBox.innerText !== message.payload.content) {
                        this.inputBox.innerText = message.payload.content;
                    }
                    break;
                }
                case 'clearInput': {
                    if (this.inputBox) {
                       this.inputBox.innerHTML = '';
                    }
                    break;
                }
                case 'focusEditorClosed': this.toggleMaximizeButton(false); break;
                case 'updateState':
                    if (message.payload.modelId) {
                        this.modelSelector.value = message.payload.modelId;
                    }
                    if (message.payload.promptId) {
                        this.promptSelector.value = message.payload.promptId;
                    }
                    break;
            }
        });
    }

    // --- highlight-start ---
    /**
     * 递归地遍历一个对象，并将所有长字符串截断。
     * @param obj 要处理的对象
     * @param maxLength 最大字符串长度，默认为 500
     * @returns 处理后的新对象
     */
    private truncateLongStrings(obj: any, maxLength: number = 500): any {
        if (!obj) {
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.truncateLongStrings(item, maxLength));
        }

        if (typeof obj === 'object') {
            const newObj: { [key: string]: any } = {};
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    newObj[key] = this.truncateLongStrings(obj[key], maxLength);
                }
            }
            return newObj;
        }

        if (typeof obj === 'string' && obj.length > maxLength) {
            return obj.substring(0, maxLength) + '... (truncated)';
        }

        return obj;
    }
    // --- highlight-end ---

    private saveCurrentConversation() {
        if (this.activeConversationId) {
            // 这是向后端发送更新后对话的请求
            // 后端 StateManager.saveConversation 会处理它
            vscode.postMessage({
                command: 'saveConversation',
                payload: {
                    id: this.activeConversationId,
                    messages: this.messages,
                    // 其他字段（如 title, createdAt）将由后端保留
                }
            });
        } else {
             // 如果是新对话，第一个Agent运行也可能触发保存
            console.warn("Attempted to save conversation, but no activeConversationId is set.");
        }
    }

    private handleSendOrSave() {
        if (this.isAgentRunning && this.activeAgentRunId) {
            vscode.postMessage({ command: 'agent:cancel', payload: { runId: this.activeAgentRunId } });
            return;
        }
        if (this.isStreaming) {
            vscode.postMessage({ command: 'stopMessage' });
            return;
        }
        
        if (this.editingMessageIndex !== null) {
            this.handleSaveEdit(this.editingMessageIndex);
        } else {
            this.handleSendMessage();
        }
    }

    private handleSendMessage() {
        if (this.isStreaming) {
            vscode.postMessage({ command: 'stopMessage' });
            return;
        }
        
        const prompt = this.inputBox.innerText.trim();
        if (!prompt) return;

        const selectedModelId = this.modelSelector.value;
        const selectedConfig = this.modelConfigs.find(c => c.id === selectedModelId);

        if (!selectedConfig) {
            vscode.postMessage({ command: 'error', payload: 'Please select a valid model from settings.' });
            return;
        }

        const message: TextChatMessage = { type: 'text', role: 'user', content: prompt };
        this.messages.push(message);
        this.renderMessages();

        this.inputBox.innerHTML = '';
        vscode.postMessage({ command: 'sendMessage', payload: { prompt, config: selectedConfig } });
    }

    private handleCopy(index: number) {
        const message = this.messages[index];
        
        if (message.type === 'text') {
            navigator.clipboard.writeText(message.content);
            vscode.postMessage({ command: 'info', payload: 'Copied to clipboard!' });
        } else {
            // 对于 Agent 运行，可以复制其最终结果或摘要
            const summary = JSON.stringify(message.run.result, null, 2);
            navigator.clipboard.writeText(summary);
             vscode.postMessage({ command: 'info', payload: 'Copied agent result summary to clipboard!' });
        }
        
    }

    private handleRegenerate(index: number) {
        vscode.postMessage({ command: 'regenerate', payload: { messageIndex: index } });
    }

    private handleEnterEditMode(index: number) {
        if (this.editingMessageIndex === index) return;
        
        const message = this.messages[index];
        if (message.type !== 'text') {
             vscode.postMessage({ command: 'info', payload: 'Agent runs cannot be edited.' });
            return; // 不允许编辑 Agent 运行
        }
        

        if (this.editingMessageIndex !== null) {
            this.handleCancelEdit();
        }

        this.editingMessageIndex = index;
        this.originalMessageContent = message.content;

        if (this.inputBox) {
            this.inputBox.innerText = this.originalMessageContent;
            this.inputBox.focus();
        }

        this.renderMessages();
        this.updateSendButtonState();
    }


    private handleCancelEdit() {
        if (this.editingMessageIndex === null) return;

        const message = this.messages[this.editingMessageIndex];
        if (this.originalMessageContent !== null && message.type === 'text') {
            message.content = this.originalMessageContent;
        }

        this.editingMessageIndex = null;
        this.originalMessageContent = null;

        if (this.inputBox) {
            this.inputBox.innerHTML = '';
        }

        this.renderMessages();
        this.updateSendButtonState();
    }

    private handleSaveEdit(index: number) {
        if (!this.inputBox) return;
        const newContent = this.inputBox.innerText.trim();
        const message = this.messages[index];
        if (newContent && message.type === 'text') {
            message.content = newContent;
            vscode.postMessage({ command: 'editMessage', payload: { messageIndex: index, content: newContent } });
        }

        this.editingMessageIndex = null;
        this.originalMessageContent = null;

        this.inputBox.innerHTML = '';

        this.renderMessages();
        this.updateSendButtonState();
    }

    private beginStream() {
        this.isStreaming = true;
        
        const assistantMessage: TextChatMessage = { type: 'text', role: 'assistant', content: '' };
        
        this.messages.push(assistantMessage);
        this.renderMessages();
        this.updateSendButtonState();
    }

    private appendStreamData(chunk: string) {
        const lastMessage = this.messages[this.messages.length - 1];
        
        if (lastMessage?.type === 'text' && lastMessage?.role === 'assistant') {
            lastMessage.content += chunk;
            this.renderMessages();
        }
        
    }


    private finalizeStream(stopped = false) {
        this.isStreaming = false;
        const lastMessage = this.messages[this.messages.length - 1];
        if (stopped && lastMessage?.type === 'text' && lastMessage?.role === 'assistant') {
            lastMessage.content += ' (Stopped)';
        }
        this.renderMessages();
        this.updateSendButtonState();
    }

    private handleRequestFailed(error: string) {
        this.finalizeStream();
        this.messages.pop();
        const lastUserMessage = this.messages.pop();

        this.renderMessages();

        if (lastUserMessage && lastUserMessage.type === 'text') {
            if (this.inputBox) this.inputBox.innerText = lastUserMessage.content;
        }

        const errorElement = document.createElement('div');
        errorElement.className = 'message-block assistant error';
        errorElement.textContent = `Error: ${error}`;
        this.messageContainer.appendChild(errorElement);
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
    }

    private handleMaximizeEditor() {
        if (this.inputBox) {
            vscode.postMessage({
                command: 'openFocusEditor',
                payload: {
                    content: this.inputBox.innerText,
                    modelId: this.modelSelector.value,
                    promptId: this.promptSelector.value
                }
            });
            this.toggleMaximizeButton(true);
        }
    }

    private toggleMaximizeButton(isMaximized: boolean) {
        const button = this.bottomPanel.querySelector('button[data-action="maximize-editor"]') as HTMLButtonElement;
        if (button) {
            if (isMaximized) {
                button.innerHTML = `<i class="codicon codicon-screen-normal"></i>`;
                button.title = '恢复至侧边栏';
            } else {
                button.innerHTML = `<i class="codicon codicon-screen-full"></i>`;
                button.title = '最大化编辑';
            }
        }
    }

    private renderMessages() {
        this.messageContainer.innerHTML = '';

        // 检查是否应该显示空状态
        if (this.messages.length === 0 && !this.activeAgentRunContainer) {
            this.messageContainer.innerHTML = this.renderEmptyState();
            return; // 显示空状态后直接返回
        }

        this.messages.forEach((msg, index) => {
            
            if (msg.type === 'agent_run') {
                // 渲染一个 AgentRunBlock
                const agentContainer = document.createElement('div');
                this.messageContainer.appendChild(agentContainer);
                // 使用 AgentRunBlock 的构造函数从历史记录中恢复
                new AgentRunBlock(agentContainer, msg.run);
            } else {
                // 渲染一个标准的 MessageBlock
                const element = new MessageBlock(msg, index).render();
                if (this.editingMessageIndex === index) {
                    element.classList.add('editing');
                }
                this.messageContainer.appendChild(element);
            }
            
        });
        
        // 如果当前有正在运行但尚未保存到 messages 数组的 Agent，它的容器也需要被处理
        if (this.activeAgentRunContainer && !this.messageContainer.contains(this.activeAgentRunContainer)) {
             this.messageContainer.appendChild(this.activeAgentRunContainer);
        }

        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
    }

    /**
     * 新增：渲染聊天视图的空状态（欢迎和引导信息）。
     * @returns 返回包含空状态内容的 HTML 字符串。
     */
    private renderEmptyState(): string {
        return `
            <div class="chat-empty-state">
                <div class="empty-state-icon">
                    <i class="codicon codicon-book"></i>
                </div>
                <h1>CodeWiki</h1>
                <h3>您的智能软件设计助手</h3>
                <div class="example-prompts">
                    <div class="example-prompt-title">您可以尝试这样开始：</div>
                    <div class="example-prompt">使用 <code>@DocGen->DocGen-Project</code> 为当前项目生成一份软件实现设计文档</div>
                    <div class="example-prompt">使用 <code>@DocGen->DocGen-Module-Direct</code> 为模块生成详细实现设计文档</div>
                    <div class="example-prompt">使用 <code>@DocGen->DocGen-Module-MapReduce</code> 用摘要总结迭代多轮的方式，为模块生成详细实现设计文档</div>
                </div>
            </div>
        `;
    }

    private renderBottomInput() {
        const container = this.bottomPanel.querySelector('.chat-input-box-container');
        if (!container) return;

        // 关键改动：使用 contenteditable div 替换 textarea
        container.innerHTML = `<div class="chat-input-box" contenteditable="true" placeholder="输入消息，或用'@'触发命令..."></div>`;
        const inputBox = container.querySelector('.chat-input-box') as HTMLElement;

        inputBox.addEventListener('keydown', (e) => {
            if (this.atCommandMenu.isVisible()) {
                this.atCommandMenu.handleKeyDown(e);
                return; // 阻止后续的 Enter 发送等行为
            }

            // 优化 Backspace 处理逻辑，使其更健壮
            if (e.key === 'Backspace') {
                const sel = window.getSelection();
                if (sel && sel.isCollapsed) {
                    const range = sel.getRangeAt(0);
                    // 此条件适用于光标位于输入框容器内，且其前方有节点（例如，在Pill之后）
                    if (range.startContainer === inputBox && range.startOffset > 0) {
                        const nodeToDelete = inputBox.childNodes[range.startOffset - 1];
                        // 检查待删除的节点是否是Pill
                        if (nodeToDelete && nodeToDelete.nodeName === 'SPAN' && (nodeToDelete as HTMLElement).classList.contains('content-pill')) {
                            e.preventDefault();
                            nodeToDelete.remove();
                            return; // 阻止默认的Backspace行为
                        }
                    }
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendOrSave();
            }
        });

        inputBox.addEventListener('input', () => {
            this.handleInputForAtCommand(inputBox);
            vscode.postMessage({
                command: 'updateWebviewContent',
                payload: { content: inputBox.innerText }
            });
        });

        // 如果输入框为空，显示 placeholder
        inputBox.addEventListener('focus', () => {
             if (inputBox.getAttribute('placeholder')) {
                inputBox.removeAttribute('placeholder');
             }
        });
        inputBox.addEventListener('blur', () => {
            if (!inputBox.textContent) {
                 inputBox.setAttribute('placeholder', "输入消息，或用'@'触发命令...");
            }
        });

        this.updateSendButtonState();
    }

    /**
     * 处理输入事件，用于触发 @ 命令菜单
     */
    private handleInputForAtCommand(inputBox: HTMLElement) {
        // 1. 如果输入框中已经存在一个Pill，则不应触发@命令菜单。
        if (inputBox.querySelector('.content-pill')) {
            this.atCommandMenu.hide();
            return;
        }

        // 2. 获取整个输入框的纯文本内容。
        const text = inputBox.innerText;

        // 3. 仅当文本以 '@' 字符开头时才显示菜单。
        //    这避免了在文本中间输入'@'时触发菜单。
        if (text.startsWith('@')) {
            // 传递@后面的部分，供菜单内部使用（即使当前过滤已禁用）
            const filter = text.substring(1);
            this.atCommandMenu.show(
                filter,
                (command) => { 
                    this.handleAgentCommandSelected(command); 
                }
            );
        } else {
            this.atCommandMenu.hide();
        }
    }

    /**
     * 新增方法：处理从 @ 菜单中选择 Agent 命令的逻辑
     * @param command 选中的 CommandLeaf 对象
     */
    private handleAgentCommandSelected(command: CommandLeaf) {
        // 1. 清空输入框
        this.inputBox.innerHTML = '';
        this.atCommandMenu.hide();

        // 2. 在消息列表中创建一个新的 div 容器，作为 AgentRunBlock 的占位符
        this.activeAgentRunContainer = document.createElement('div');
        this.messageContainer.appendChild(this.activeAgentRunContainer);
        
        // 确保视图滚动到底部，以便用户能看到新创建的容器（即使它现在是空的）
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;

        // 3. 向后端发送消息，请求这个 Agent 的执行计划
        vscode.postMessage({
            command: 'agent:getPlan',
            payload: {
                agentId: command.agentId
            }
        });
    }

    /**
     * 将选中的 Agent 命令作为 "Pill" 插入到输入框中
     */
    // 更新方法签名以接收完整的 CommandLeaf 对象
    private insertAgentPill(command: { agentId: string, name: string }) {
        // 使用更具描述性的 Pill 内容
        const pillHtml = `<span class="content-pill" contenteditable="false" data-agent-id="${command.agentId}">@${command.name}</span> `;
        
        // 清空输入框并插入 Pill
        this.inputBox.innerHTML = pillHtml;
        this.inputBox.focus();

        // 移动光标到最后
        const selection = window.getSelection();
        if (selection) {
            const range = document.createRange();
            range.selectNodeContents(this.inputBox);
            range.collapse(false); // false 表示折叠到末尾
            selection.removeAllRanges();
            selection.addRange(range);
        }

        this.atCommandMenu.hide();
    }

    private updateSendButtonState() {
        const sendButton = this.bottomPanel.querySelector<HTMLButtonElement>('button[data-action="send-or-save"]');
        if (sendButton) {
            if (this.isAgentRunning || this.isStreaming) {
                sendButton.innerHTML = `<i class="codicon codicon-stop-circle"></i> Stop`;
                sendButton.classList.add('streaming');
                sendButton.title = 'Stop Generation';
            } 
            else if (this.editingMessageIndex !== null) {
                sendButton.textContent = 'Save';
                sendButton.classList.remove('streaming');
                sendButton.title = 'Save Changes';
            } else {
                sendButton.textContent = 'Send';
                sendButton.classList.remove('streaming');
                sendButton.title = 'Send Message';
            }
        }
    }

    private renderInitialLayout(): string {
        return `
            <div class="chat-container">
                <div class="messages-list"></div>
                <div class="chat-sticky-bottom">
                    <div class="at-command-menu-container"></div>
                    <div class="chat-quick-actions">
                        <label for="model-selector">Model:</label>
                        <select id="model-selector"></select>
                        <label for="prompt-selector">Prompt:</label>
                        <select id="prompt-selector"></select>
                        <button data-action="maximize-editor" title="最大化编辑">
                            <i class="codicon codicon-screen-full"></i>
                        </button>
                        <button data-action="send-or-save">Send</button>
                    </div>
                    <div class="chat-input-box-container"></div>
                </div>
            </div>
        `;
    }

    private renderModelSelector() {
        this.modelSelector.innerHTML = '';
        const defaultModel = this.modelConfigs.find(c => c.isDefault);
        this.modelConfigs.forEach(config => {
            const option = document.createElement('option');
            option.value = config.id;
            option.textContent = config.name;
            if (defaultModel && config.id === defaultModel.id) {
                option.selected = true;
            }
            this.modelSelector.appendChild(option);
        });
    }

    private renderPromptSelector() {
        this.promptSelector.innerHTML = '<option value="">Select a prompt...</option>';
        this.prompts.forEach(prompt => {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.title;
            this.promptSelector.appendChild(option);
        });
    }

    private autoResizeInput(textarea: HTMLTextAreaElement) {
        textarea.style.height = 'auto';
        const scrollHeight = textarea.scrollHeight;
        const maxHeight = 250; // Synced with main.css

        if (scrollHeight > maxHeight) {
            textarea.style.height = `${maxHeight}px`;
            textarea.style.overflowY = 'auto';
        } else {
            textarea.style.height = `${scrollHeight}px`;
            textarea.style.overflowY = 'hidden';
        }
    }
    
    // --- 新增：模拟后端处理器 ---
    private mockBackendHandler(agentId: string, agentName: string) {
        // 1. 创建 AgentRunBlock 的容器并添加到聊天列表中
        const agentRunContainer = document.createElement('div');
        this.messageContainer.appendChild(agentRunContainer);
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;

        // 2. 定义模拟的 AgentPlan 数据
        const mockPlan: AgentPlan = {
            agentId: 'docgen-project',
            agentName: '项目级文档生成',
            steps: [
                { name: "规划: 分析项目结构", description: "分析文件树，规划需要分析的核心模块。", promptFiles: ['project_planner.yml'] },
                { name: "执行: 并行分析所有模块", description: "为每个已规划的模块生成详细的文档。", promptFiles: ['module_analysis_direct.yml', 'module_analysis_mapreduce.yml']},
                { name: "综合: 生成最终文档", description: "将所有模块分析结果汇编成最终的项目设计文档。", promptFiles: ['project_synthesis.yml'] }
            ],
            parameters: [] // 项目级文档生成不需要参数
        };


        // 3. 定义执行回调，当用户点击“开始执行”时触发
        const onExecute = (params: Record<string, any>) => {
            console.log("Mock backend received execute command with params:", params);
            this.runMockExecution(agentBlock, mockPlan);
        };

        // 4. 创建 AgentRunBlock 实例，传入容器、计划和回调
        const agentBlock = new AgentRunBlock(agentRunContainer, mockPlan, onExecute);
    }
    
    // --- 新增：模拟执行流程 ---
    private runMockExecution(agentBlock: AgentRunBlock, plan: AgentPlan) {
        const runId = `run_${Date.now()}`;
        let eventIndex = 0;
        
        // 模拟从 plan.json 读取到的模块列表
        const plannedModules = [
            { name: "核心业务模块", path: "agile-boot/agile-spring-boot-starter" },
            { name: "前端控制台工具", path: "agile-boot/agile-console" },
            { name: "后台管理服务", path: "agile-boot/agile-serve-admin" },
            { name: "文件上传服务", path: "agile-boot/agile-spring-upload" },
            { name: "RESTful接口服务", path: "agile-boot/agile-serve-restful" },
            { name: "验证码服务", path: "agile-boot/agile-spring-captcha" }
        ];

        // 高保真模拟事件流
        const mockEventStream: (StepExecution | StepUpdate | StreamChunk | AgentResult)[] = [
            // === 阶段 1: 规划 ===
            { runId, taskId: 'task_plan', stepName: "规划: 分析项目结构", status: 'running' } as StepExecution,
            { runId, taskId: 'task_plan', type: 'llm-request', data: { name: '规划请求' }, metadata: { type: 'file', path: '.codewiki/runs/.../01_planning_request.txt' } } as StepUpdate,
            { runId, taskId: 'task_plan', type: 'output', data: { name: '规划响应' }, metadata: { type: 'file', path: '.codewiki/runs/.../01_planning_response.txt' } } as StepUpdate,
            { runId, taskId: 'task_plan', stepName: "规划: 分析项目结构", status: 'completed' } as StepExecution,

            // === 阶段 2: 并行分析 (父任务启动) ===
            { runId, taskId: 'task_parallel_parent', stepName: "执行: 并行分析所有模块", status: 'running' } as StepExecution,
            
            // --- 模拟所有子任务的创建 ---
            { runId, taskId: 'task_mod_1', stepName: "分析模块: '核心业务模块'", status: 'running' } as StepExecution,
            { runId, taskId: 'task_mod_2', stepName: "分析模块: '前端控制台工具'", status: 'running' } as StepExecution,
            { runId, taskId: 'task_mod_3', stepName: "分析模块: '后台管理服务'", status: 'running' } as StepExecution,
            // ... 其他模块也在这里启动

            // --- 模块 1 的完整生命周期 ---
            { runId, taskId: 'task_mod_1', type: 'llm-request', data: { name: '核心业务模块分析请求' }, metadata: { type: 'file', path: '.codewiki/runs/.../module_agile-spring-boot-starter/llm_request.txt' } } as StepUpdate,
            // (此时UI应显示等待动画)
            { runId, taskId: 'task_mod_1', content: '### 核心业务模块\n\n该模块是系统的核心...' } as StreamChunk,
            { runId, taskId: 'task_mod_1', content: '它包含了主要的业务逻辑和实体定义。' } as StreamChunk,
            { runId, taskId: 'task_mod_1', type: 'output', data: { name: '模块文档' }, metadata: { type: 'file', path: '.codewiki/runs/.../module_核心业务模块.md' } } as StepUpdate,
            { runId, taskId: 'task_mod_1', stepName: "分析模块: '核心业务模块'", status: 'completed' } as StepExecution,

            // --- 模块 2 的完整生命周期 ---
            { runId, taskId: 'task_mod_2', type: 'llm-request', data: { name: '前端控制台工具分析请求' }, metadata: { type: 'file', path: '.codewiki/runs/.../module_agile-console/llm_request.txt' } } as StepUpdate,
            // (UI显示等待)
            { runId, taskId: 'task_mod_2', content: '### 前端控制台工具\n\n提供了命令行工具...' } as StreamChunk,
            { runId, taskId: 'task_mod_2', type: 'output', data: { name: '模块文档' }, metadata: { type: 'file', path: '.codewiki/runs/.../module_前端控制台工具.md' } } as StepUpdate,
            { runId, taskId: 'task_mod_2', stepName: "分析模块: '前端控制台工具'", status: 'completed' } as StepExecution,

            // ... (模块3 及以后同理)
            { runId, taskId: 'task_mod_3', type: 'llm-request', data: { name: '后台管理服务分析请求' }, metadata: { type: 'file', path: '.codewiki/runs/.../module_agile-serve-admin/llm_request.txt' } } as StepUpdate,
            { runId, taskId: 'task_mod_3', type: 'output', data: { name: '模块文档' }, metadata: { type: 'file', path: '.codewiki/runs/.../module_后台管理服务.md' } } as StepUpdate,
            { runId, taskId: 'task_mod_3', stepName: "分析模块: '后台管理服务'", status: 'completed' } as StepExecution,


            // === 阶段 2: 并行分析 (父任务完成) ===
            { runId, taskId: 'task_parallel_parent', stepName: "执行: 并行分析所有模块", status: 'completed' } as StepExecution,
            
            // === 阶段 3: 综合 (也遵循完整周期) ===
            { runId, taskId: 'task_synthesis', stepName: "综合: 生成最终文档", status: 'running' } as StepExecution,
            { runId, taskId: 'task_synthesis', type: 'llm-request', data: { name: '综合请求' }, metadata: { type: 'file', path: '.codewiki/runs/.../03_synthesis_request.txt' } } as StepUpdate,
            // (UI显示等待)
            { runId, taskId: 'task_synthesis', content: '# Agile-Boot 项目总体设计文档\n\n' } as StreamChunk,
            { runId, taskId: 'task_synthesis', content: '本文档旨在提供Agile-Boot项目的整体架构...' } as StreamChunk,
            { runId, taskId: 'task_synthesis', stepName: "综合: 生成最终文档", status: 'completed' } as StepExecution,

            // === 最终结果 ===
            { runId, status: 'completed', finalOutput: "项目总体设计文档.md 已生成。" } as AgentResult
        ];


        const intervalId = setInterval(() => {
            if (eventIndex >= mockEventStream.length) {
                clearInterval(intervalId);
                return;
            }

            const event = mockEventStream[eventIndex++];
            
            
            // 更稳健的类型检查和派发，修复了原有逻辑错误
            if ('stepName' in event && 'status' in event && 'runId' in event) {
                // 这是 StepExecution 事件
                agentBlock.updateStepExecutionStatus(event as StepExecution | StepResult); 
            } else if ('status' in event && 'runId' in event && !('stepName' in event)) {
                // 这是 AgentResult 事件
                 agentBlock.setAgentResult(event as AgentResult);
            } else if ('type' in event && 'data' in event) {
                // 这是 StepUpdate 事件
                agentBlock.addStepLog(event as StepUpdate);
            } else if ('content' in event && !('role' in event)) {
                // 这是 StreamChunk 事件
                 agentBlock.appendStreamChunk(event as StreamChunk);
            }
            

        }, 3000); // 每 800 毫秒发送一个事件
    }
}