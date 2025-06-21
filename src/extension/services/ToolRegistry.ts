// src/extension/services/ToolRegistry.ts (完整文件)

import { StructuredTool } from '@langchain/core/tools';
import { ModelConfig } from '../../common/types';
import { GetFileSummariesTool, GetFilesContentByListTool, GetAllFilesContentTool, GetDirectoryTreeTool } from '../tools/fileSystemTools';
import { createFileSelectorLLMTool } from '../tools/llmTools';
import { LLMService } from './LLMService';

/**
 * 负责在扩展启动时初始化所有工具，并按需提供。
 * 这是一个集中管理工具的单例服务。
 */
export class ToolRegistry {
    private tools = new Map<string, StructuredTool>();

    constructor(private llmService: LLMService) {}

    /**
     * 初始化所有工具，特别是那些需要LLM实例的工具。
     * @param defaultModelConfig 用于创建工具内部LLM的默认模型配置。
     */
    public async initialize(defaultModelConfig: ModelConfig): Promise<void> {
        // 为工具创建一个专用的、非流式的LLM实例
        const toolLlm = await this.llmService.createModel({
            modelConfig: defaultModelConfig,
            temperature: 0.1,
            streaming: false,
        });

        const allTools: StructuredTool[] = [
            new GetFileSummariesTool(),
            new GetFilesContentByListTool(),
            new GetAllFilesContentTool(),
            new GetDirectoryTreeTool(),
            createFileSelectorLLMTool(toolLlm, this.llmService),
        ];

        for (const tool of allTools) {
            this.tools.set(tool.name, tool);
        }
        console.log("ToolRegistry initialized with tools:", Array.from(this.tools.keys()));
    }

    /**
     * 根据名称获取单个工具。
     * @param name 工具的名称。
     * @returns 返回工具实例，如果找不到则返回undefined。
     */
    public getTool(name: string): StructuredTool | undefined {
        return this.tools.get(name);
    }
    
    /**
     * 根据名称列表获取一组工具。
     * @param names 工具名称的数组。
     * @returns 返回工具实例的数组。
     * @throws 如果有任何一个工具找不到，则抛出错误。
     */
    public getTools(names: string[]): StructuredTool[] {
         return names.map(name => {
             const tool = this.getTool(name);
             if (!tool) {
                 throw new Error(`Tool "${name}" not found in registry.`);
             }
             return tool;
         });
    }
}