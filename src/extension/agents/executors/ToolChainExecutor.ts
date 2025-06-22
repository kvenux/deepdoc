import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { ToolChainStep, LlmPromptTemplate } from '../CustomAgentExecutor'; // 保持这个 import
import { AgentContext } from '../AgentContext';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';

// 定义 YAML 解析后的结构类型
interface ActionPrompt {
    tool_chain: ToolChainStep[];
    llm_prompt_template: LlmPromptTemplate;
}

export class ToolChainExecutor {
    constructor(private readonly context: AgentContext) {}

    public async run(runId: string, yamlContent: string, userInputs: Record<string, any>): Promise<string> {
        const { logger, llmService, toolRegistry, modelConfig, runDir } = this.context;
        let finalResult = '';

        try {
            const parseTaskId = uuidv4();
            const parseStepName = "解析YAML配置";
            logger.onStepStart({ runId, taskId: parseTaskId, stepName: parseStepName, status: 'running' });
            
            // 修正: 使用明确的 ActionPrompt 类型
            const actionPrompt = yaml.load(yamlContent) as ActionPrompt;

            if (!actionPrompt.tool_chain || !actionPrompt.llm_prompt_template) {
                throw new Error("无效的Action Prompt YAML格式。缺少 'tool_chain' 或 'llm_prompt_template'。");
            }
            logger.onStepEnd({ runId, taskId: parseTaskId, status: 'completed' });

            const executionContext: Record<string, any> = { ...userInputs };

            for (const step of actionPrompt.tool_chain) { // 修正: 现在 actionPrompt 有正确的类型
                const toolTaskId = uuidv4();
                const stepName = `执行工具: ${step.tool}`;
                logger.onStepStart({ runId, taskId: toolTaskId, stepName, status: 'running' });

                const tool = toolRegistry.getTool(step.tool);
                if (!tool) {
                    throw new Error(`工具 "${step.tool}" 未找到。`);
                }
                
                const toolInput = this.resolveInput(step.input, executionContext);
                logger.onStepUpdate({ runId, taskId: toolTaskId, type: 'input', data: { name: "工具输入", content: toolInput } });
                
                const toolOutputString = await tool.call(toolInput) as string; // 修正：添加类型断言
                const toolOutputParsed = this.parseToolOutput(toolOutputString);
                executionContext[step.output_variable] = toolOutputParsed;
                
                logger.onStepUpdate({ runId, taskId: toolTaskId, type: 'output', data: { name: "工具输出", content: toolOutputString } });
                logger.onStepEnd({ runId, taskId: toolTaskId, status: 'completed' });
            }
            
            const llmTaskId = uuidv4();
            const llmStepName = "生成最终响应";
            logger.onStepStart({ runId, taskId: llmTaskId, stepName: llmStepName, status: 'running' });
            
            // 修正: 声明并赋值 systemMessageContent 和 humanMessageContent
            const systemMessageContent = this.resolveInput(actionPrompt.llm_prompt_template.system, executionContext);
            const humanMessageContent = this.resolveInput(actionPrompt.llm_prompt_template.human, executionContext);

            const llmRequest = { system: systemMessageContent, human: humanMessageContent };
            logger.onStepUpdate({ runId, taskId: llmTaskId, type: 'llm-request', data: llmRequest });
            if (runDir) {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runDir, 'llm_request.txt'), Buffer.from(`[SYSTEM]\n${systemMessageContent}\n\n[HUMAN]\n${humanMessageContent}`, 'utf8'));
            }

            const finalLlm = await llmService.createModel({ modelConfig, streaming: true, temperature: 0.7 });
            const finalChain = finalLlm.pipe(new StringOutputParser());
            // 修正：使用已定义的变量
            const stream = await finalChain.stream([ new SystemMessage(systemMessageContent), new HumanMessage(humanMessageContent) ]);
            
            for await (const chunk of stream) {
                finalResult += chunk;
                logger.onStreamChunk({ runId, taskId: llmTaskId, content: chunk });
            }
            
            logger.onStepUpdate({ runId, taskId: llmTaskId, type: 'output', data: { name: "LLM响应", content: finalResult }, metadata: { type: 'markdown' } });
            if (runDir) {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runDir, 'llm_response.md'), Buffer.from(finalResult, 'utf8'));
            }
            logger.onStepEnd({ runId, taskId: llmTaskId, status: 'completed' });

            return finalResult;

        } catch (error: any) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw err;
        }
    }

    private resolveInput(inputTemplate: any, context: Record<string, any>): any {
        if (typeof inputTemplate === 'string') {
            const match = inputTemplate.match(/^\{(\w+)\}$/);
            if (match && context[match[1]] !== undefined) {
                return context[match[1]];
            }
            return inputTemplate.replace(/\{(\w+)\}/g, (m, key) => {
                return context[key] !== undefined ? String(context[key]) : m;
            });
        }
        if (typeof inputTemplate !== 'object' || inputTemplate === null) {
            return inputTemplate;
        }
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
        } catch (e) {}
        return outputString;
    }
}