// src/extension/agents/CustomAgentExecutor.ts (已再次修正)

import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { StructuredTool } from '@langchain/core/tools';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';

// ... (接口定义保持不变) ...
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
    onLlmStart?: () => void;
    onLlmStream?: (chunk: string) => void;
    onLlmEnd?: () => void;
    onError?: (error: Error) => void;
}


export class CustomAgentExecutor {
    private tools: Map<string, StructuredTool>;
    private finalLlm: BaseLanguageModel;

    constructor(tools: StructuredTool[], finalLlm: BaseLanguageModel) {
        this.tools = new Map(tools.map(tool => [tool.name, tool]));
        this.finalLlm = finalLlm;
    }

    public async run(
        tool_chain: ToolChainStep[],
        initialInputs: Record<string, string>,
        llm_prompt_template: LlmPromptTemplate,
        callbacks: AgentExecutorCallbacks
    ): Promise<void> {
        const context: Record<string, any> = { ...initialInputs };
        
        // --- 日志: 打印初始上下文 ---
        console.log("--- [Agent Start] ---");
        console.log("Initial Context:", JSON.stringify(context, null, 2));
        console.log("----------------------");

        try {
            for (const step of tool_chain) {
                const tool = this.tools.get(step.tool);
                if (!tool) {
                    throw new Error(`Tool "${step.tool}" not found.`);
                }
                
                // --- 日志: 打印将要执行的工具和它的输入模板 ---
                console.log(`\n--- [Tool Start] Executing: ${step.tool} ---`);
                console.log("Input Template:", JSON.stringify(step.input, null, 2));

                const toolInput = this.resolveInput(step.input, context);

                // --- 日志: 打印解析后的、实际传递给工具的输入 ---
                console.log("Resolved Input:", JSON.stringify(toolInput, null, 2));
                
                callbacks.onToolStart?.(tool.name, toolInput);

                const toolOutputString = await tool.call(toolInput);
                
                const toolOutputParsed = this.parseToolOutput(toolOutputString);
                context[step.output_variable] = toolOutputParsed;

                // --- 日志: 打印工具的原始输出和解析后的输出 ---
                const outputSummary = toolOutputString.length > 500 ? `${toolOutputString.substring(0, 500)}...` : toolOutputString;
                console.log("Tool Raw Output (truncated):", outputSummary);
                if (typeof toolOutputParsed !== 'string') {
                    console.log(`Parsed Output (variable "${step.output_variable}"):`, toolOutputParsed);
                }
                console.log(`--- [Tool End] Finished: ${step.tool} ---\n`);

                callbacks.onToolEnd?.(tool.name, outputSummary);
            }
            
            // --- 日志: 打印工具链执行完毕后的最终上下文 ---
            console.log("--- [Final LLM Start] ---");
            // 注意：不直接打印整个 context，因为 selected_files_content 可能非常大
            const contextKeys = Object.keys(context);
            console.log("Final Context Keys:", contextKeys);
            if(context.selected_files_list) {
                console.log("Final Context 'selected_files_list':", context.selected_files_list);
            }
            console.log("LLM Prompt Template:", llm_prompt_template);
            
            callbacks.onLlmStart?.();
            
            const systemMessageContent = this.resolveInput(llm_prompt_template.system, context) as string;
            const humanMessageContent = this.resolveInput(llm_prompt_template.human, context) as string;

            // --- 日志: 打印最终注入到 LLM 的 Prompt ---
            const finalPromptSummary = humanMessageContent.length > 1000 ? `${humanMessageContent.substring(0, 1000)}...` : humanMessageContent;
            console.log("Final Human Message (truncated):", finalPromptSummary);
            console.log("-------------------------");

            const finalPrompt = ChatPromptTemplate.fromMessages([
                new SystemMessage(systemMessageContent),
                new HumanMessage(humanMessageContent)
            ]);

            const finalChain = finalPrompt.pipe(this.finalLlm).pipe(new StringOutputParser());

            const stream = await finalChain.stream({});
            for await (const chunk of stream) {
                callbacks.onLlmStream?.(chunk);
            }
            
            callbacks.onLlmEnd?.();

        } catch (error: any) {
            console.error("Error in CustomAgentExecutor:", error);
            callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * 解析工具的输入，用上下文中的值替换 {placeholder}。
     * @param inputTemplate - 来自 tool_chain 的输入定义。
     * @param context - 当前的执行上下文。
     * @returns 解析后的输入，准备传递给工具。
     */
    private resolveInput(inputTemplate: string | Record<string, any>, context: Record<string, any>): any {
        if (typeof inputTemplate === 'string') {
            const match = inputTemplate.match(/^\{(\w+)\}$/);
            // 关键修正: 检查占位符是否是模板字符串的唯一内容
            // 如果是，并且上下文中的值不是字符串，则直接返回该值（如数组）
            if (match && context[match[1]] !== undefined) {
                return context[match[1]];
            }
            
            // 否则，执行常规的字符串替换 (所有值都会被转为字符串)
            return inputTemplate.replace(/\{(\w+)\}/g, (m, key) => {
                return context[key] !== undefined ? String(context[key]) : m;
            });
        }
        
        // 递归处理对象
        const resolvedObject: Record<string, any> = {};
        for (const key in inputTemplate) {
            const value = inputTemplate[key];
            resolvedObject[key] = this.resolveInput(value, context);
        }
        return resolvedObject;
    }

    private parseToolOutput(outputString: string): any {
        try {
            if ((outputString.startsWith('[') && outputString.endsWith(']')) || (outputString.startsWith('{') && outputString.endsWith('}'))) {
                return JSON.parse(outputString);
            }
        } catch (e) {
            // 解析失败，不是有效的JSON，返回原始字符串
        }
        return outputString;
    }
}