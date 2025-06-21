// src/extension/agents/executors/ToolChainExecutor.ts (修改后完整文件)

import * as vscode from 'vscode'; // <-- 新增 import
import * as yaml from 'js-yaml';
import { CustomAgentExecutor, ToolChainStep, LlmPromptTemplate, AgentExecutorCallbacks } from '../CustomAgentExecutor';
import { AgentContext } from '../AgentContext';

/**
 * 一个执行器，专门负责运行定义了 "tool_chain" 和 "llm_prompt_template" 的 Action Prompt。
 * 它封装了工具链的执行逻辑。
 */
export class ToolChainExecutor {
    constructor(private readonly context: AgentContext) {}

    public async run(yamlContent: string, userInputs: Record<string, any>): Promise<string> {
        const { logger, llmService, toolRegistry, runDir } = this.context; // <-- 获取 runDir
        
        logger.info("Parsing Tool-Chain YAML...");
        const actionPrompt = yaml.load(yamlContent) as {
            tool_chain: ToolChainStep[];
            llm_prompt_template: LlmPromptTemplate;
        };

        if (!actionPrompt.tool_chain || !actionPrompt.llm_prompt_template) {
            throw new Error("Invalid Action Prompt YAML format. Missing 'tool_chain' or 'llm_prompt_template'.");
        }

        const toolNames = actionPrompt.tool_chain.map(step => step.tool);
        const tools = toolRegistry.getTools(toolNames);
        
        const finalLlm = await llmService.createModel({
            modelConfig: this.context.modelConfig,
            streaming: true,
            temperature: 0.7,
        });

        const callbacks: AgentExecutorCallbacks = {
            onToolStart: (toolName, input) => {
                logger.info(`> Executing tool: ${toolName}...`);
            },
            onToolEnd: (toolName, output) => {
                logger.info(`- Tool ${toolName} finished.`);
            },
            onLlmStart: async (system, human) => { // <-- 设为 async
                logger.info("> Generating final response with LLM...");
                // --- 新增：写入请求文件 ---
                if (runDir) {
                    const requestContent = `[SYSTEM]\n${system}\n\n---\n\n[HUMAN]\n${human}`;
                    const requestPath = vscode.Uri.joinPath(runDir, `llm_request.txt`);
                    await vscode.workspace.fs.writeFile(requestPath, Buffer.from(requestContent, 'utf8'));
                }
            },
            onLlmStream: (chunk) => {
                if (this.context.logger.constructor.name === 'WebviewLogger') {
                    this.context.logger.log(chunk);
                }
            },
            onLlmEnd: async (finalResult) => { // <-- 设为 async
                 logger.info("- Final response generated.");
                 // --- 新增：写入响应文件 ---
                 if (runDir) {
                    const responsePath = vscode.Uri.joinPath(runDir, `llm_response.md`);
                    await vscode.workspace.fs.writeFile(responsePath, Buffer.from(finalResult, 'utf8'));
                 }
            },
            onError: (error) => {
                logger.error("Tool-Chain execution failed", error);
            }
        };

        const agentExecutor = new CustomAgentExecutor(tools, finalLlm);

        const finalResult = await agentExecutor.run(
            actionPrompt.tool_chain,
            userInputs,
            actionPrompt.llm_prompt_template,
            callbacks
        );

        return finalResult;
    }
}