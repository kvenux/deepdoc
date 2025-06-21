// src/extension/agents/CustomAgentExecutor.ts (修改后完整文件)

import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { StructuredTool } from '@langchain/core/tools';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';

export interface ToolChainStep {
    tool: string;
    input: string | Record<string, any>;
    output_variable: string;
}
export interface LlmPromptTemplate {
    system: string;
    human: string;
}
export interface AgentExecutorCallbacks {
    onToolStart?: (toolName: string, input: any) => void;
    onToolEnd?: (toolName:string, output: string) => void;
    onLlmStart?: (finalSystemPrompt: string, finalHumanPrompt: string) => void;
    onLlmStream?: (chunk: string) => void;
    onLlmEnd?: (finalResult: string) => void;
    onError?: (error: Error) => void;
}


export class CustomAgentExecutor {
    private tools: Map<string, StructuredTool>;
    private finalLlm: BaseLanguageModel;

    constructor(tools: StructuredTool[], finalLlm: BaseLanguageModel) {
        this.tools = new Map(tools.map(tool => [tool.name, tool]));
        this.finalLlm = finalLlm;
    }

    // --- 修改点：run 方法现在返回 Promise<string> ---
    public async run(
        tool_chain: ToolChainStep[],
        initialInputs: Record<string, string>,
        llm_prompt_template: LlmPromptTemplate,
        callbacks: AgentExecutorCallbacks
    ): Promise<string> { // <-- 返回类型修改
        return new Promise(async (resolve, reject) => {
            const context: Record<string, any> = { ...initialInputs };
        
            try {
                for (const step of tool_chain) {
                    const tool = this.tools.get(step.tool);
                    if (!tool) {
                        throw new Error(`Tool "${step.tool}" not found.`);
                    }
                    
                    const toolInput = this.resolveInput(step.input, context);
                    callbacks.onToolStart?.(tool.name, toolInput);

                    const toolOutputString = await tool.call(toolInput);
                    const toolOutputParsed = this.parseToolOutput(toolOutputString);
                    context[step.output_variable] = toolOutputParsed;

                    const outputSummary = toolOutputString.length > 500 ? `${toolOutputString.substring(0, 500)}...` : toolOutputString;
                    callbacks.onToolEnd?.(tool.name, outputSummary);
                }
                
                const systemMessageContent = this.resolveInput(llm_prompt_template.system, context) as string;
                const humanMessageContent = this.resolveInput(llm_prompt_template.human, context) as string;

                callbacks.onLlmStart?.(systemMessageContent, humanMessageContent);

                const finalPrompt = ChatPromptTemplate.fromMessages([
                    new SystemMessage(systemMessageContent),
                    new HumanMessage(humanMessageContent)
                ]);

                const finalChain = finalPrompt.pipe(this.finalLlm).pipe(new StringOutputParser());

                const stream = await finalChain.stream({});
                let fullReply = '';
                for await (const chunk of stream) {
                    fullReply += chunk;
                    callbacks.onLlmStream?.(chunk);
                }
                callbacks.onLlmEnd?.(fullReply);
                
                resolve(fullReply); // --- 修改点：用最终结果 resolve Promise ---

            } catch (error: any) {
                const err = error instanceof Error ? error : new Error(String(error));
                callbacks.onError?.(err);
                reject(err); // --- 修改点：用错误 reject Promise ---
            }
        });
    }

    private resolveInput(inputTemplate: string | Record<string, any>, context: Record<string, any>): any {
        // ... 此方法实现保持不变 ...
        if (typeof inputTemplate === 'string') {
            const match = inputTemplate.match(/^\{(\w+)\}$/);
            if (match && context[match[1]] !== undefined) {
                return context[match[1]];
            }
            return inputTemplate.replace(/\{(\w+)\}/g, (m, key) => {
                return context[key] !== undefined ? String(context[key]) : m;
            });
        }
        const resolvedObject: Record<string, any> = {};
        for (const key in inputTemplate) {
            const value = inputTemplate[key];
            resolvedObject[key] = this.resolveInput(value, context);
        }
        return resolvedObject;
    }

    private parseToolOutput(outputString: string): any {
        // ... 此方法实现保持不变 ...
        try {
            if ((outputString.startsWith('[') && outputString.endsWith(']')) || (outputString.startsWith('{') && outputString.endsWith('}'))) {
                return JSON.parse(outputString);
            }
        } catch (e) {}
        return outputString;
    }
}