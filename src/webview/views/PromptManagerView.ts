import { Prompt } from '../../common/types';
import { vscode } from '../vscode';

export class PromptManagerView {
    private prompts: Prompt[] = [];
    private filteredPrompts: Prompt[] = [];
    private element: HTMLElement;

    constructor(private readonly parent: HTMLElement) {
        this.element = document.createElement('div');
        this.element.className = 'prompt-manager-view';
        this.parent.appendChild(this.element);
        this.render();
        this.addEventListeners();
    }

    public update(prompts: Prompt[]) {
        this.prompts = prompts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        this.filteredPrompts = [...this.prompts];
        this.render();
        this.addEventListeners();
    }

    public getPrompts(): Prompt[] {
        return this.prompts;
    }

    private render() {
        this.element.innerHTML = `
            <div class="view-header">
                <div class="search-bar">
                    <i class="codicon codicon-search"></i>
                    <input type="text" id="prompt-search-input" placeholder="搜索提示词...">
                </div>
                <button id="new-prompt-btn" class="codicon-btn">
                    <i class="codicon codicon-add"></i>
                    <span>新建提示词</span>
                </button>
            </div>
            <div class="prompt-list-container">
                ${this.filteredPrompts.length > 0 ? this.renderList() : this.renderEmptyState()}
            </div>
        `;
    }

    private renderList(): string {
        return `
            <ul class="prompt-list">
                ${this.filteredPrompts.map(prompt => this.renderListItem(prompt)).join('')}
            </ul>
        `;
    }

    private renderListItem(prompt: Prompt): string {
        const summary = prompt.content.substring(0, 100) + (prompt.content.length > 100 ? '...' : '');
        const lastUpdated = new Date(prompt.updatedAt).toLocaleString();

        return `
            <li class="prompt-list-item" data-id="${prompt.id}">
                <div class="prompt-item-main">
                    <div class="prompt-item-title">${prompt.title}</div>
                    <div class="prompt-item-summary">${summary}</div>
                </div>
                <div class="prompt-item-meta">
                    <div class="prompt-item-time">${lastUpdated}</div>
                    <div class="prompt-item-actions">
                        <button class="icon-btn edit-prompt-btn" data-id="${prompt.id}" title="编辑">
                            <i class="codicon codicon-edit"></i>
                        </button>
                        <button class="icon-btn delete-prompt-btn" data-id="${prompt.id}" title="删除">
                            <i class="codicon codicon-trash"></i>
                        </button>
                    </div>
                </div>
            </li>
        `;
    }

    private renderEmptyState(): string {
        return `
            <div class="empty-state">
                <p>您还没有任何提示词模板，点击“新建提示词”来创建第一个吧！</p>
                <button id="new-prompt-btn-empty" class="highlighted-btn">新建提示词</button>
            </div>
        `;
    }

    private addEventListeners() {
        // New prompt button
        const newPromptBtn = this.element.querySelector('#new-prompt-btn');
        if (newPromptBtn) {
            newPromptBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'newPrompt' });
            });
        }
        const newPromptBtnEmpty = this.element.querySelector('#new-prompt-btn-empty');
        if (newPromptBtnEmpty) {
            newPromptBtnEmpty.addEventListener('click', () => {
                vscode.postMessage({ command: 'newPrompt' });
            });
        }

        // Search input
        const searchInput = this.element.querySelector('#prompt-search-input') as HTMLInputElement;
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const searchTerm = (e.target as HTMLInputElement).value.toLowerCase();
                this.filteredPrompts = this.prompts.filter(p => 
                    p.title.toLowerCase().includes(searchTerm) || 
                    p.content.toLowerCase().includes(searchTerm)
                );
                this.render();
                this.addEventListeners();
            });
        }

        // List item clicks
        this.element.querySelectorAll('.prompt-list-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                // Don't trigger edit if clicking on a button
                if (!target.closest('button')) {
                    const promptId = item.getAttribute('data-id');
                    if (promptId) {
                        vscode.postMessage({ command: 'editPrompt', payload: { id: promptId } });
                    }
                }
            });
        });

        // Edit buttons
        this.element.querySelectorAll('.edit-prompt-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const promptId = (btn as HTMLElement).dataset.id;
                if (promptId) {
                    vscode.postMessage({ command: 'editPrompt', payload: { id: promptId } });
                }
            });
        });

        // Delete buttons
        this.element.querySelectorAll('.delete-prompt-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const promptId = (btn as HTMLElement).dataset.id;
                if (promptId) {
                    vscode.postMessage({ command: 'deletePrompt', payload: { id: promptId } });
                }
            });
        });
    }
}
