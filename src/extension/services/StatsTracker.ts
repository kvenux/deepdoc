// src/extension/services/StatsTracker.ts
import { get_encoding, Tiktoken } from "tiktoken";

export interface AgentRunStats {
    duration: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
}

/**
 * 在单次 Agent 运行期间跟踪和计算统计信息。
 */
export class StatsTracker {
    private startTime: number;
    private totalPromptTokens: number = 0;
    private totalCompletionTokens: number = 0;
    private tokenizer: Tiktoken;

    constructor() {
        this.startTime = Date.now();
        // 使用一个通用的编码器来估算，cl100k_base 适用于大多数现代 OpenAI 模型
        this.tokenizer = get_encoding("cl100k_base");
    }

    /**
     * 记录一次LLM调用的Token消耗。
     * @param prompt - 发送给模型的完整提示文本。
     * @param completion - 从模型接收到的完整响应文本。
     */
    public add(prompt: string, completion: string): void {
        try {
            const promptTokens = this.tokenizer.encode(prompt).length;
            const completionTokens = this.tokenizer.encode(completion).length;
            
            this.totalPromptTokens += promptTokens;
            this.totalCompletionTokens += completionTokens;
        } catch (e) {
            console.error("Token counting failed:", e);
        }
    }

    /**
     * 计算并返回最终的统计数据。
     * @returns {AgentRunStats} 最终的统计对象。
     */
    public getFinalStats(): AgentRunStats {
        const endTime = Date.now();
        const durationMs = endTime - this.startTime;
        const durationSec = (durationMs / 1000).toFixed(2);
        
        // 释放 tokenizer 资源
        this.tokenizer.free();

        return {
            duration: `${durationSec}s`,
            promptTokens: this.totalPromptTokens,
            completionTokens: this.totalCompletionTokens,
            totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
        };
    }
}