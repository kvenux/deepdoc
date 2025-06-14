import { ModelConfig } from "../../common/types";
import { vscode } from "../vscode";

export class SettingsView {
    private configs: ModelConfig[] = [];

    constructor(private readonly parent: HTMLElement) {
        this.render();
        this.setupEventListeners();
    }

    public setModelConfigs(configs: ModelConfig[]) {
        this.configs = configs;
        this.render();
    }

    public getModelConfigs(): ModelConfig[] {
        return this.configs;
    }

    private setupEventListeners() {
        this.parent.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const button = target.closest('button');
            if (!button) return;

            const id = button.dataset.id;
            if (button.matches('.btn-add-model')) {
                this.addEmptyConfigForm();
            } else if (button.matches('.btn-save-model')) {
                this.saveConfig(id);
            } else if (button.matches('.btn-delete-model')) {
                this.deleteConfig(id);
            } else if (button.matches('.btn-set-default')) {
                this.setDefault(id);
            }
        });
    }

    private addEmptyConfigForm() {
        const newConfig: ModelConfig = { 
            id: `new-${Date.now()}`, 
            name: '', 
            baseUrl: '', 
            apiKey: '', 
            modelId: '',
            isDefault: this.configs.length === 0 
        };
        this.configs.push(newConfig);
        this.render();
    }

    private saveAllConfigs() {
        vscode.postMessage({ command: 'saveModelConfigs', payload: this.configs });
    }

    private setDefault(id?: string) {
        if (!id) return;
        this.configs.forEach(c => c.isDefault = c.id === id);
        this.saveAllConfigs();
        this.render();
    }

    private saveConfig(id?: string) {
        if (!id) return;
        const form = this.parent.querySelector(`#config-form-${id}`) as HTMLFormElement;
        if (!form) return;

        const name = (form.querySelector('input[name="name"]') as HTMLInputElement).value;
        const baseUrl = (form.querySelector('input[name="baseUrl"]') as HTMLInputElement).value;
        const apiKey = (form.querySelector('input[name="apiKey"]') as HTMLInputElement).value;
        const modelId = (form.querySelector('input[name="modelId"]') as HTMLInputElement).value;

        const index = this.configs.findIndex(c => c.id === id);
        if (index === -1) return;

        const isNew = id.startsWith('new-');
        const newId = isNew ? `model-${Date.now()}` : id;
        
        this.configs[index] = { ...this.configs[index], id: newId, name, baseUrl, apiKey, modelId };
        
        this.saveAllConfigs();
    }

    private deleteConfig(id?: string) {
        if (!id) return;
        this.configs = this.configs.filter(c => c.id !== id);
        // If the deleted model was the default, make the first one default
        if (this.configs.length > 0 && !this.configs.some(c => c.isDefault)) {
            this.configs[0].isDefault = true;
        }
        this.saveAllConfigs();
    }

    private render() {
        this.parent.innerHTML = `
            <div class="settings-container">
                <div class="view-header">
                    <h2>Model Settings</h2>
                    <button class="btn-add-model add-btn" title="Add new model configuration">
                        <i class="codicon codicon-add"></i>
                    </button>
                </div>
                <div id="model-configs-list">
                    ${this.configs.map(config => this.renderConfigForm(config)).join('')}
                </div>
            </div>
        `;
    }

    private renderConfigForm(config: ModelConfig): string {
        return `
            <form class="config-form" id="config-form-${config.id}" data-id="${config.id}">
                <div class="form-header">
                    <strong class="form-title">${config.name || 'New Model'}</strong>
                    ${config.isDefault ? '<span class="default-badge">Default</span>' : ''}
                </div>
                <div class="form-group">
                    <label for="name-${config.id}">Model Name</label>
                    <input type="text" id="name-${config.id}" name="name" placeholder="e.g., GPT-4o" value="${config.name}">
                </div>
                <div class="form-group">
                    <label for="baseUrl-${config.id}">Base URL</label>
                    <input type="text" id="baseUrl-${config.id}" name="baseUrl" placeholder="https://api.openai.com/v1" value="${config.baseUrl}">
                </div>
                <div class="form-group">
                    <label for="apiKey-${config.id}">API Key</label>
                    <input type="password" id="apiKey-${config.id}" name="apiKey" placeholder="sk-..." value="${config.apiKey}">
                </div>
                <div class="form-group">
                    <label for="modelId-${config.id}">Model ID</label>
                    <input type="text" id="modelId-${config.id}" name="modelId" placeholder="gpt-4o" value="${config.modelId}">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn-save-model" data-id="${config.id}">Save</button>
                    <button type="button" class="btn-delete-model" data-id="${config.id}">Delete</button>
                    ${!config.isDefault ? `<button type="button" class="btn-set-default" data-id="${config.id}">Set as Default</button>` : ''}
                </div>
            </form>
        `;
    }
}
