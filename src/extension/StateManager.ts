import * as vscode from 'vscode';
import { Conversation, ModelConfig, Prompt, PerformanceConfig } from '../common/types';

const CONVERSATIONS_KEY = 'codewiki_conversations';
const PROMPTS_KEY = 'codewiki_prompts';
const MODEL_CONFIGS_KEY = 'codewiki_model_configs';
const PERFORMANCE_CONFIG_KEY = 'codewiki_performance_config'; // 新增 Key

/**
 * 默认的性能配置
 */
const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = {
    concurrencyLimit: 5,   // 默认并发数
    minInterval: 10000,     // 默认请求间隔 1 秒
    maxTokensPerBatch: 64000, // 默认 Map-Reduce 批处理大小
    maxTokensForDirectAnalysis: 64000 // 默认直接分析阈值
};


/**
 * Manages the state of the extension, persisting data in VS Code's global state.
 * This class acts as the single source of truth for all persistent data.
 */
export class StateManager {
    constructor(private readonly globalState: vscode.Memento) {}

    //== Conversation Management ==//

    public async getConversations(): Promise<Conversation[]> {
        return this.globalState.get<Conversation[]>(CONVERSATIONS_KEY, []);
    }

    public async saveConversation(conversation: Conversation): Promise<void> {
        const conversations = await this.getConversations();
        const index = conversations.findIndex(c => c.id === conversation.id);
        if (index !== -1) {
            conversations[index] = conversation;
        } else {
            conversations.push(conversation);
        }
        await this.globalState.update(CONVERSATIONS_KEY, conversations);
    }

    public async deleteConversation(id: string): Promise<void> {
        const conversations = await this.getConversations();
        const filteredConversations = conversations.filter(c => c.id !== id);
        await this.globalState.update(CONVERSATIONS_KEY, filteredConversations);
    }

    //== Prompt Management ==//

    public async getPrompts(): Promise<Prompt[]> {
        return this.globalState.get<Prompt[]>(PROMPTS_KEY, []);
    }

    public async savePrompt(prompt: Prompt): Promise<void> {
        const prompts = await this.getPrompts();
        const index = prompts.findIndex(p => p.id === prompt.id);
        if (index !== -1) {
            prompts[index] = prompt;
        } else {
            prompts.push(prompt);
        }
        await this.globalState.update(PROMPTS_KEY, prompts);
    }

    public async deletePrompt(id: string): Promise<void> {
        const prompts = await this.getPrompts();
        const filteredPrompts = prompts.filter(p => p.id !== id);
        await this.globalState.update(PROMPTS_KEY, filteredPrompts);
    }

    //== Model Config Management ==//

   public async getModelConfigs(): Promise<ModelConfig[]> {
        // 直接从 globalState 获取配置，如果不存在，则返回一个空数组。
        return this.globalState.get<ModelConfig[]>(MODEL_CONFIGS_KEY, []);
    }

    public async saveModelConfigs(configs: ModelConfig[]): Promise<void> {
        // Ensure only one model is default
        let defaultFound = false;
        configs.forEach(config => {
            if (config.isDefault) {
                if (defaultFound) {
                    config.isDefault = false; // Unset other defaults
                } else {
                    defaultFound = true;
                }
            }
        });

        // If no default is set, make the first one default
        if (!defaultFound && configs.length > 0) {
            configs[0].isDefault = true;
        }

        await this.globalState.update(MODEL_CONFIGS_KEY, configs);
    }

     //== Performance Config Management ==//

    public async getPerformanceConfig(): Promise<PerformanceConfig> {
        const savedConfig = this.globalState.get<Partial<PerformanceConfig>>(PERFORMANCE_CONFIG_KEY, {});
        // 合并已保存的配置和默认配置，确保所有字段都有值
        return { ...DEFAULT_PERFORMANCE_CONFIG, ...savedConfig };
    }

    public async savePerformanceConfig(config: PerformanceConfig): Promise<void> {
        await this.globalState.update(PERFORMANCE_CONFIG_KEY, config);
    }
}
