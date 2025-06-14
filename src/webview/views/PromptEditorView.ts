import { Prompt } from '../../common/types';
import { vscode } from '../vscode';

export class PromptEditorView {
    private element: HTMLElement;
    private prompt: Prompt | null = null;
    private isDirty = false;

    constructor(private readonly parent: HTMLElement) {
        this.element = document.createElement('div');
        this.element.className = 'prompt-editor-view';
        this.parent.appendChild(this.element);
    }

    public show(prompt?: Prompt) {
        this.prompt = prompt ? { ...prompt } : null;
        this.isDirty = false;
        this.render();
        this.addEventListeners();
        this.element.style.display = 'flex';
    }

    public hide() {
        if (this.isDirty) {
            const confirmation = window.confirm('您有未保存的更改，确定要放弃吗？');
            if (!confirmation) {
                return;
            }
        }
        this.element.style.display = 'none';
        this.element.innerHTML = '';
        // Let the extension handle the navigation
        vscode.postMessage({ command: 'cancelPromptEdit' });
    }

    private render() {
        const title = this.prompt?.title ?? '';
        const content = this.prompt?.content ?? '';
        const headerTitle = this.prompt ? `编辑: ${title}` : '新建提示词';

        this.element.innerHTML = `
            <div class="view-header">
                <h3>${headerTitle}</h3>
                <div class="actions">
                    <button id="save-prompt-btn" class="codicon-btn">
                        <i class="codicon codicon-save"></i>
                        <span>保存</span>
                    </button>
                    <button id="cancel-prompt-edit-btn" class="codicon-btn secondary">
                        <i class="codicon codicon-close"></i>
                        <span>取消</span>
                    </button>
                </div>
            </div>
            <div class="prompt-editor-form">
                <div class="form-group">
                    <label for="prompt-title">标题</label>
                    <input type="text" id="prompt-title" value="${title}" required>
                </div>
                <div class="form-group">
                    <label for="prompt-content">内容</label>
                    <textarea id="prompt-content" rows="15">${content}</textarea>
                </div>
            </div>
        `;
    }

    private addEventListeners() {
        const saveBtn = this.element.querySelector('#save-prompt-btn');
        const cancelBtn = this.element.querySelector('#cancel-prompt-edit-btn');
        const titleInput = this.element.querySelector('#prompt-title') as HTMLInputElement;
        const contentTextArea = this.element.querySelector('#prompt-content') as HTMLTextAreaElement;

        const markDirty = () => { this.isDirty = true; };
        titleInput.addEventListener('input', markDirty);
        contentTextArea.addEventListener('input', markDirty);

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                if (!titleInput.value.trim()) {
                    vscode.postMessage({ command: 'showError', payload: '标题不能为空。' });
                    return;
                }

                const now = new Date().toISOString();
                const promptToSave: Prompt = {
                    id: this.prompt?.id || `prompt_${Date.now()}`,
                    title: titleInput.value.trim(),
                    content: contentTextArea.value,
                    createdAt: this.prompt?.createdAt || now,
                    updatedAt: now,
                };

                vscode.postMessage({ command: 'savePrompt', payload: promptToSave });
                this.isDirty = false;
            });
        }

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.hide();
            });
        }
    }
}
