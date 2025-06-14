import { Conversation, ChatMessage, ModelConfig, Prompt } from "../../common/types";
import { vscode } from "../vscode";
import { MessageBlock } from "../components/MessageBlock";

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

    constructor(private readonly parent: HTMLElement) {
        this.parent.innerHTML = this.renderInitialLayout();
        this.messageContainer = this.parent.querySelector('.messages-list') as HTMLElement;
        this.bottomPanel = this.parent.querySelector('.chat-sticky-bottom') as HTMLElement;
        this.modelSelector = this.parent.querySelector('#model-selector') as HTMLSelectElement;
        this.promptSelector = this.parent.querySelector('#prompt-selector') as HTMLSelectElement;
        this.renderBottomInput();
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
                    const inputBox = this.bottomPanel.querySelector('textarea');
                    if (inputBox) {
                        inputBox.value = selectedPrompt.content;
                        this.autoResizeInput(inputBox);
                        inputBox.focus();
                        vscode.postMessage({
                            command: 'updateWebviewContent',
                            payload: { content: inputBox.value }
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
                    const inputBox = this.bottomPanel.querySelector('textarea');
                    if (inputBox && inputBox.value !== message.payload.content) {
                        inputBox.value = message.payload.content;
                        this.autoResizeInput(inputBox);
                    }
                    break;
                }
                case 'clearInput': {
                    const inputBox = this.bottomPanel.querySelector('textarea');
                    if (inputBox) {
                        inputBox.value = '';
                        this.autoResizeInput(inputBox);
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

        const inputBox = this.bottomPanel.querySelector('textarea');
        if (!inputBox) return;

        const prompt = inputBox.value.trim();
        if (prompt) {
            const selectedModelId = this.modelSelector.value;
            const selectedConfig = this.modelConfigs.find(c => c.id === selectedModelId);

            if (!selectedConfig) {
                vscode.postMessage({ command: 'error', payload: 'Please select a valid model from settings.' });
                return;
            }

            const message: ChatMessage = { role: 'user', content: prompt };
            this.messages.push(message);
            this.renderMessages();

            inputBox.value = '';
            this.autoResizeInput(inputBox);
            vscode.postMessage({ command: 'sendMessage', payload: { prompt, config: selectedConfig } });
        }
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

        const mainTextarea = this.bottomPanel.querySelector('textarea');
        if (mainTextarea) {
            mainTextarea.value = this.originalMessageContent;
            this.autoResizeInput(mainTextarea);
            mainTextarea.focus();
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

        const mainTextarea = this.bottomPanel.querySelector('textarea');
        if (mainTextarea) {
            mainTextarea.value = '';
            this.autoResizeInput(mainTextarea);
        }

        this.renderMessages();
        this.updateSendButtonState();
    }

    private handleSaveEdit(index: number) {
        const mainTextarea = this.bottomPanel.querySelector('textarea');
        if (!mainTextarea) return;

        const newContent = mainTextarea.value.trim();
        if (newContent) {
            this.messages[index].content = newContent;
            vscode.postMessage({ command: 'editMessage', payload: { messageIndex: index, content: newContent } });
        }

        this.editingMessageIndex = null;
        this.originalMessageContent = null;

        mainTextarea.value = '';
        this.autoResizeInput(mainTextarea);

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
            const inputBox = this.bottomPanel.querySelector('textarea');
            if (inputBox) inputBox.value = lastUserMessage.content;
        }

        const errorElement = document.createElement('div');
        errorElement.className = 'message-block assistant error';
        errorElement.textContent = `Error: ${error}`;
        this.messageContainer.appendChild(errorElement);
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
    }

    private handleMaximizeEditor() {
        const inputBox = this.bottomPanel.querySelector('textarea');
        if (inputBox) {
            vscode.postMessage({
                command: 'openFocusEditor',
                payload: {
                    content: inputBox.value,
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

        container.innerHTML = `<textarea placeholder="输入消息，或从下拉菜单选择提示词..."></textarea>`;
        const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendOrSave();
            }
        });

        textarea.addEventListener('input', () => {
            this.autoResizeInput(textarea);
            vscode.postMessage({
                command: 'updateWebviewContent',
                payload: { content: textarea.value }
            });
        });

        this.updateSendButtonState();
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
