// src/extension/agentRunner.ts

import * as yaml from 'js-yaml';
import { ChatOpenAI } from '@langchain/openai';
import { StructuredTool } from '@langchain/core/tools';
import { CustomAgentExecutor, ToolChainStep, LlmPromptTemplate, AgentExecutorCallbacks } from './agents/CustomAgentExecutor';
import { ModelConfig } from '../common/types';

interface RunActionPromptOptions {
    yamlContent: string;
    userInputs: Record<string, string>;
    modelConfig: ModelConfig;
    tools: StructuredTool[];
    callbacks: AgentExecutorCallbacks;
}

/**
 * 负责执行一个 Action Prompt 的核心逻辑。
 * 此函数被设计为可重用的，可以被 VS Code 命令或 Webview 消息处理器调用。
 * @param options - 包含执行所需所有参数的对象。
 */
export async function runActionPrompt(options: RunActionPromptOptions): Promise<void> {
    const { yamlContent, userInputs, modelConfig, tools, callbacks } = options;

    try {
        // 1. 解析 YAML 内容
        const actionPrompt = yaml.load(yamlContent) as {
            tool_chain: ToolChainStep[];
            llm_prompt_template: LlmPromptTemplate;
        };

        if (!actionPrompt.tool_chain || !actionPrompt.llm_prompt_template) {
            throw new Error("Invalid Action Prompt YAML format. Missing 'tool_chain' or 'llm_prompt_template'.");
        }

        // 2. 根据传入的模型配置，动态创建 LLM 实例
        const finalLlm = new ChatOpenAI({
            modelName: modelConfig.modelId,
            apiKey: modelConfig.apiKey,
            streaming: true,
            temperature: 0.7,
            configuration: { baseURL: modelConfig.baseUrl },
        });

        // 3. 创建 Agent Executor 实例
        // 注意：这里的 Agent Executor 是即时创建的，确保它使用了最新的 LLM 配置
        const agentExecutor = new CustomAgentExecutor(tools, finalLlm);

        // 4. 启动 Agent Executor
        await agentExecutor.run(
            actionPrompt.tool_chain,
            userInputs,
            actionPrompt.llm_prompt_template,
            callbacks
        );

    } catch (error: any) {
        // 将错误传递给回调函数进行处理
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
    }
}