import { Conversation, ChatMessage, ModelConfig, Prompt } from "../../common/types";
import { vscode } from "../vscode";
import { MessageBlock } from "../components/MessageBlock";
import { AtCommandMenu } from "../components/AtCommandMenu";

export class ChatView {
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
            this.messages = conversations[conversations.length - 1].messages;
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

    private handleSendOrSave() {
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
        
        // highlight-start
        // 检查输入框中是否已有 Pill
        const pill = this.inputBox.querySelector('.content-pill');
        if (pill) {
            const agentId = pill.getAttribute('data-agent-id');
            vscode.postMessage({command: 'info', payload: `触发 Agent: ${agentId} (模拟)`});
            
            // 在阶段二，我们只是清空输入框，为未来的 AgentRunBlock 留出空间
            // 实际的后端调用和 UI 渲染将在任务 2 和 3 中实现
            this.inputBox.innerHTML = '';
            
            return; // 结束执行
        }

        const prompt = this.inputBox.innerText.trim();
        if (!prompt) return;
        // highlight-end

        const selectedModelId = this.modelSelector.value;
        const selectedConfig = this.modelConfigs.find(c => c.id === selectedModelId);

        if (!selectedConfig) {
            vscode.postMessage({ command: 'error', payload: 'Please select a valid model from settings.' });
            return;
        }

        const message: ChatMessage = { role: 'user', content: prompt };
        this.messages.push(message);
        this.renderMessages();

        // highlight-start
        this.inputBox.innerHTML = '';
        // highlight-end
        vscode.postMessage({ command: 'sendMessage', payload: { prompt, config: selectedConfig } });
    }

    private handleCopy(index: number) {
        navigator.clipboard.writeText(this.messages[index].content);
        vscode.postMessage({ command: 'info', payload: 'Copied to clipboard!' });
    }

    private handleRegenerate(index: number) {
        vscode.postMessage({ command: 'regenerate', payload: { messageIndex: index } });
    }

    private handleEnterEditMode(index: number) {
        if (this.editingMessageIndex === index) return;

        if (this.editingMessageIndex !== null) {
            this.handleCancelEdit();
        }

        this.editingMessageIndex = index;
        this.originalMessageContent = this.messages[index].content;

        if (this.inputBox) {
            this.inputBox.innerText = this.originalMessageContent;
            this.inputBox.focus();
        }

        this.renderMessages();
        this.updateSendButtonState();
    }

    private handleCancelEdit() {
        if (this.editingMessageIndex === null) return;

        if (this.originalMessageContent !== null) {
            this.messages[this.editingMessageIndex].content = this.originalMessageContent;
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
        if (newContent) {
            this.messages[index].content = newContent;
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
        const assistantMessage: ChatMessage = { role: 'assistant', content: '' };
        this.messages.push(assistantMessage);
        this.renderMessages();
        this.updateSendButtonState();
    }

    private appendStreamData(chunk: string) {
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage?.role === 'assistant') {
            lastMessage.content += chunk;
            this.renderMessages();
        }
    }

    private finalizeStream(stopped = false) {
        this.isStreaming = false;
        const lastMessage = this.messages[this.messages.length - 1];
        if (stopped && lastMessage?.role === 'assistant') {
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

        if (lastUserMessage) {
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
        this.messages.forEach((msg, index) => {
            const element = new MessageBlock(msg, index).render();
            if (this.editingMessageIndex === index) {
                element.classList.add('editing');
            }
            this.messageContainer.appendChild(element);
        });
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
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

            // 新增 Backspace 处理逻辑
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
                (command) => { this.insertAgentPill(command); }
            );
        } else {
            this.atCommandMenu.hide();
        }
    }

    /**
     * 将选中的 Agent 命令作为 "Pill" 插入到输入框中
     */
    // 更新方法签名以接收完整的 CommandLeaf 对象
    private insertAgentPill(command: { agentId: string, name: string }) {
        // 使用更具描述性的 Pill 内容
        const pillHtml = `<span class="content-pill" contenteditable="false" data-agent-id="${command.agentId}">@${command.name}</span> `;
        
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
        const sendButton = this.bottomPanel.querySelector('button[data-action="send-or-save"]');
        if (sendButton) {
            if (this.isStreaming) {
                sendButton.textContent = 'Stop';
                sendButton.classList.add('streaming');
            } else if (this.editingMessageIndex !== null) {
                sendButton.textContent = 'Save';
                sendButton.classList.remove('streaming');
            } else {
                sendButton.textContent = 'Send';
                sendButton.classList.remove('streaming');
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
}
