// file_path: extension/agents/executors/ToolChainExecutor.ts
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { ToolChainStep, LlmPromptTemplate } from '../CustomAgentExecutor';
import { AgentContext } from '../AgentContext';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ExecutorResult } from './MapReduceExecutor'; // 导入统一的返回类型


interface ActionPrompt {
    tool_chain: ToolChainStep[];
    llm_prompt_template: LlmPromptTemplate;
}

export class ToolChainExecutor {
    constructor(private readonly context: AgentContext) { }

    public async run(runId: string, yamlContent: string, userInputs: Record<string, any>): Promise<ExecutorResult> {
        const { logger, llmService, toolRegistry, modelConfig, runDir, statsTracker } = this.context;
        let finalResult = '';

        try {
            const parseTaskId = uuidv4();
            const actionPrompt = yaml.load(yamlContent) as ActionPrompt;
            if (!actionPrompt.tool_chain || !actionPrompt.llm_prompt_template) {
                throw new Error("无效的Action Prompt YAML格式。缺少 'tool_chain' 或 'llm_prompt_template'。");
            }
            const executionContext: Record<string, any> = { ...userInputs };

            for (const step of actionPrompt.tool_chain) {
                const toolTaskId = uuidv4();
                const toolStepName = `执行工具`; // 使用这个作为 stepName
                logger.onStepStart({ runId, taskId: toolTaskId, stepName: toolStepName, status: 'running' });

                const tool = toolRegistry.getTool(step.tool);
                if (!tool) {
                    throw new Error(`工具 "${step.tool}" 未找到。`);
                }

                const toolInput = this.resolveInput(step.input, executionContext);
                logger.onStepUpdate({ runId, taskId: toolTaskId, type: 'input', data: { name: `工具输入 ${step.tool} `, content: toolInput } });

                const toolOutputString = await tool.call(toolInput) as string;
                const toolOutputParsed = this.parseToolOutput(toolOutputString);
                executionContext[step.output_variable] = toolOutputParsed;

                logger.onStepUpdate({ runId, taskId: toolTaskId, type: 'output', data: { name: `工具输出 ${step.tool} `, content: toolOutputString } });
                logger.onStepEnd({ runId, taskId: toolTaskId, stepName: toolStepName, status: 'completed' }); // 修正: 添加 stepName
            }

            const llmTaskId = uuidv4();
            const llmStepName = "生成最终响应";
            logger.onStepStart({ runId, taskId: llmTaskId, stepName: llmStepName, status: 'running' });

            const systemMessageContent = this.resolveInput(actionPrompt.llm_prompt_template.system, executionContext);
            const humanMessageContent = this.resolveInput(actionPrompt.llm_prompt_template.human, executionContext);

            const llmRequest = { system: systemMessageContent, human: humanMessageContent };
            logger.onStepUpdate({ runId, taskId: llmTaskId, type: 'llm-request', data: llmRequest });
            if (runDir) {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runDir, 'llm_request.txt'), Buffer.from(`[SYSTEM]\n${systemMessageContent}\n\n[HUMAN]\n${humanMessageContent}`, 'utf8'));
            }

            const finalLlm = await llmService.createModel({ modelConfig, streaming: true, temperature: 0.7 });
            const finalChain = finalLlm.pipe(new StringOutputParser());

            // 修改此处的调用，添加重试选项
            finalResult = await llmService.scheduleLlmCall(async () => {
                const stream = await finalChain.stream([new SystemMessage(systemMessageContent), new HumanMessage(humanMessageContent)]);
                let fullReply = '';
                for await (const chunk of stream) {
                    fullReply += chunk;
                }
                return fullReply;
            }, { maxRetries: 3 }); // 明确要求重试
            
            console.log("finalResult", finalResult);
            // 修复：为 statsTracker 提供完整的 prompt
            statsTracker.add(systemMessageContent + "\n" + humanMessageContent, finalResult);

            logger.onStepUpdate({ runId, taskId: llmTaskId, type: 'output', data: { name: "模块文档", content: finalResult }, metadata: { type: 'markdown' } });
            if (runDir) {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runDir, 'llm_response.md'), Buffer.from(finalResult, 'utf8'));
            }
            logger.onStepEnd({ runId, taskId: llmTaskId, stepName: llmStepName, status: 'completed' }); // 修正: 添加 stepName

            return {
                finalContent: finalResult,
                intermediateFiles: [] // ToolChainExecutor 通常没有需要特别返回的中间文件
            };

        } catch (error: any) {
            const err = error instanceof Error ? error : new Error(String(error));
            // 如果错误发生在特定步骤，应该在该步骤的 catch 中记录 onStepEnd(failed)
            // 这里的 throw 会被 AgentService 捕获并调用 onAgentEnd(failed)
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
        } catch (e) { }
        return outputString;
    }
}