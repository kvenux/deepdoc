import { vscode } from "../vscode";
import { ModelConfig, Prompt } from "../../common/types";

export class FocusEditorView {
    private parent: HTMLElement;
    private modelConfigs: ModelConfig[] = [];
    private prompts: Prompt[] = [];
    private modelSelector: HTMLSelectElement;
    private promptSelector: HTMLSelectElement;
    private textarea: HTMLTextAreaElement;

    constructor(container: HTMLElement, initialData: { content: string, modelId?: string, promptId?: string }) {
        this.parent = container;
        this.parent.innerHTML = this.render();
        
        this.modelSelector = this.parent.querySelector('#model-selector') as HTMLSelectElement;
        this.promptSelector = this.parent.querySelector('#prompt-selector') as HTMLSelectElement;
        this.textarea = this.parent.querySelector('textarea') as HTMLTextAreaElement;

        this.textarea.value = initialData.content;
        if (initialData.modelId) {
            this.modelSelector.value = initialData.modelId;
        }
        if (initialData.promptId) {
            this.promptSelector.value = initialData.promptId;
        }

        this.setupEventListeners();
    }

    public render(): string {
        return `
            <div class="focus-editor-container">
                <div class="chat-quick-actions">
                    <label for="model-selector">Model:</label>
                    <select id="model-selector"></select>
                    <label for="prompt-selector">Prompt:</label>
                    <select id="prompt-selector"></select>
                    <button data-action="minimize-editor" title="恢复至侧边栏">
                        <i class="codicon codicon-screen-normal"></i>
                    </button>
                    <button data-action="send-message">Send</button>
                </div>
                <div class="chat-input-box-container">
                     <textarea placeholder="输入消息，或从下拉菜单选择提示词..."></textarea>
                </div>
            </div>
        `;
    }

    private setupEventListeners() {
        this.parent.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const button = target.closest('button');
            if (!button) return;

            const action = button.dataset.action;
            switch (action) {
                case 'send-message':
                    this.handleSendMessage();
                    break;
                case 'minimize-editor':
                    vscode.postMessage({ command: 'closeFocusEditor' });
                    break;
            }
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
        });

        this.textarea.addEventListener('input', () => {
            vscode.postMessage({
                command: 'updateWebviewContent',
                payload: { content: this.textarea.value }
            });
        });

        this.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendMessage();
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateState':
                    this.updateState(message.payload);
                    break;
                case 'updatePrompts':
                    this.setPrompts(message.payload);
                    break;
                case 'updateContent':
                    this.updateContent(message.payload.content);
                    break;
            }
        });
    }

    public setModelConfigs(configs: ModelConfig[]) {
        this.modelConfigs = configs;
        const currentVal = this.modelSelector.value;
        this.renderModelSelector();
        this.modelSelector.value = currentVal;
    }

    public setPrompts(prompts: Prompt[]) {
        this.prompts = prompts;
        const currentVal = this.promptSelector.value;
        this.renderPromptSelector();
        this.promptSelector.value = currentVal;
    }

    public updateContent(content: string) {
        if (this.textarea.value !== content) {
            this.textarea.value = content;
        }
    }

    public updateState(state: { modelId?: string, promptId?: string }) {
        if (state.modelId) {
            this.modelSelector.value = state.modelId;
        }
        if (state.promptId) {
            this.promptSelector.value = state.promptId;
        }
    }

    public clearInput() {
        this.textarea.value = '';
    }

    private handleSendMessage() {
        const prompt = this.textarea.value.trim();
        if (prompt) {
            const selectedModelId = this.modelSelector.value;
            const selectedConfig = this.modelConfigs.find(c => c.id === selectedModelId);

            if (!selectedConfig) {
                vscode.postMessage({ command: 'error', payload: 'Please select a valid model from settings.' });
                return;
            }
            
            vscode.postMessage({ command: 'sendMessage', payload: { prompt, config: selectedConfig } });
            this.clearInput();
        }
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

}
