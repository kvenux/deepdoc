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
export async function runActionPrompt(options: RunActionPromptOptions): Promise<string> {
    return new Promise(async (resolve, reject) => {
        const { yamlContent, userInputs, modelConfig, tools, callbacks } = options;
        
        try {
            const actionPrompt = yaml.load(yamlContent) as {
                tool_chain: ToolChainStep[];
                llm_prompt_template: LlmPromptTemplate;
            };

            if (!actionPrompt.tool_chain || !actionPrompt.llm_prompt_template) {
                throw new Error("Invalid Action Prompt YAML format. Missing 'tool_chain' or 'llm_prompt_template'.");
            }

            const finalLlm = new ChatOpenAI({
                modelName: modelConfig.modelId,
                apiKey: modelConfig.apiKey,
                streaming: true,
                temperature: 0.7,
                configuration: { baseURL: modelConfig.baseUrl },
            });

            // 增强 callbacks 以支持 Promise 解析
            const enhancedCallbacks: AgentExecutorCallbacks = {
                ...callbacks,
                onLlmEnd: (result) => {
                    callbacks.onLlmEnd?.(result);
                    resolve(result); // 当LLM结束时，用最终结果解析Promise
                },
                onError: (err) => {
                    callbacks.onError?.(err);
                    reject(err); // 当出错时，拒绝Promise
                }
            };

            const agentExecutor = new CustomAgentExecutor(tools, finalLlm);

            // 启动 Agent Executor，但不再需要 await 它，因为 Promise 会处理完成状态
            agentExecutor.run(
                actionPrompt.tool_chain,
                userInputs,
                actionPrompt.llm_prompt_template,
                enhancedCallbacks
            );

        } catch (error: any) {
            const err = error instanceof Error ? error : new Error(String(error));
            callbacks.onError?.(err);
            reject(err); // 捕获同步错误
        }
    });
}