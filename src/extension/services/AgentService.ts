// src/extension/services/AgentService.ts (完整文件)

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { ModelConfig, AgentPlan } from '../../common/types';
import { AgentContext } from '../agents/AgentContext';
import { ProjectDocumentationOrchestrator } from '../agents/orchestrators/ProjectDocumentationOrchestrator';
import { ToolChainExecutor } from '../agents/executors/ToolChainExecutor';
import { MapReduceExecutor } from '../agents/executors/MapReduceExecutor';
import { AgentLogger, VscodeOutputChannelLogger, WebviewLogger } from './logging';
import { LLMService } from './LLMService';
import { ToolRegistry } from './ToolRegistry';
import { StatsTracker } from './StatsTracker';

// 在文件顶部或一个新文件中定义Agent元数据
/**
 * Agent元数据定义。
 * 这是所有可用Agent的“注册表”，定义了它们的ID、名称、步骤和所需参数。
 */
const AGENT_DEFINITIONS: Record<string, AgentPlan> = {
    'docgen-project': {
        agentId: 'docgen-project',
        agentName: '项目级文档生成',
        steps: [
            { name: "规划: 分析项目结构", description: "使用LLM分析文件树，识别核心模块。", promptFiles: ['project_planner.yml'] },
            { name: "分析: 并行处理模块", description: "对每个模块进行深入分析，可能使用直接或Map-Reduce策略。", promptFiles: ['module_analysis_direct.yml', 'module_analysis_mapreduce.yml'] },
            { name: "综合: 生成最终文档", description: "将所有模块的分析结果汇编成一篇完整的技术文档。", promptFiles: ['project_synthesis.yml'] }
        ],
        parameters: [] // 此Agent无需用户输入额外参数
    },
    'docgen-module-direct': {
        agentId: 'docgen-module-direct',
        agentName: '模块级文档 (直接分析)',
        steps: [
            { name: "执行工具", description: "按顺序执行文件读取和分析工具。", promptFiles: ['module_analysis_direct.yml'] },
            { name: "生成最终响应", description: "使用LLM整合工具输出，生成模块文档。" }
        ],
        parameters: [
            { name: 'module_path', description: '需要分析的模块/文件夹路径', type: 'path' }
        ]
    },
    'docgen-module-mapreduce': {
        agentId: 'docgen-module-mapreduce',
        agentName: '模块级文档 (摘要总结)',
        steps: [
            { name: "解析与准备", description: "扫描指定路径下的所有文件并根据Token限制进行分批。" },
            { name: "Map阶段: 并行分析", description: "并行调用LLM为每个文件批次生成摘要。", promptFiles: ['module_analysis_mapreduce.yml'] },
            { name: "Reduce阶段: 综合摘要", description: "将所有批次的摘要合并，并由LLM生成最终的模块文档。" }
        ],
        parameters: [
            { name: 'module_path', description: '需要分析的模块/文件夹路径', type: 'path' }
        ]
    }
};

// 辅助函数：用于加载外部YAML文件
async function loadPromptFile(workspaceRoot: vscode.Uri, fileName: string): Promise<string> {
    const promptUri = vscode.Uri.joinPath(workspaceRoot, '.codewiki', fileName);
    try {
        const fileContent = await vscode.workspace.fs.readFile(promptUri);
        return Buffer.from(fileContent).toString('utf-8');
    } catch (e) {
        throw new Error(`无法加载提示词文件: ${fileName}。请确保它存在于 '.codewiki' 目录中。`);
    }
}


/**
 * AgentService 是UI层（如Commands, Webviews）与后台Agent执行逻辑之间的唯一接口。
 * 它负责组装Agent运行所需的一切，并启动它们。
 */
export class AgentService {
    private toolRegistry: ToolRegistry;
    private activeRuns = new Map<string, { logger: AgentLogger }>();

    constructor(private llmService: LLMService) {
        this.toolRegistry = new ToolRegistry(this.llmService);
    }

    public async initialize(defaultModelConfig: ModelConfig): Promise<void> {
        await this.toolRegistry.initialize(defaultModelConfig);
        console.log("AgentService initialized successfully.");
    }

    /**
     * 根据 Agent ID 获取其预定义的计划（元数据）。
     * @param agentId Agent的唯一标识符。
     * @returns 返回 AgentPlan 对象，如果未找到则返回 null。
     */
    public getAgentPlan(agentId: string): AgentPlan | null {
        const plan = AGENT_DEFINITIONS[agentId];
        return plan ? { ...plan } : null; // 返回一个副本以避免意外修改
    }

    /**
     * 取消一个正在运行的 Agent。
     * @param runId 要取消的运行的ID。
     */
    public async cancelAgentRun(runId: string) {
        const run = this.activeRuns.get(runId);
        if (run) {
            console.log(`Cancelling agent run ${runId}`);
            // 发送一个 "cancelled" 状态的最终事件
            run.logger.onAgentEnd({
                runId,
                status: 'cancelled',
                error: 'Agent run was cancelled by the user.'
            });
            // 从活动运行中移除，以防止后续的 'completed' 或 'failed' 事件被发送
            this.activeRuns.delete(runId);
        }
    }

    public async prepareAndRunAgent(
        agentId: string,
        userInputs: Record<string, any>,
        modelConfig: ModelConfig,
        logger: AgentLogger
    ) {
        const runId = uuidv4();
        const agentPlan = this.getAgentPlan(agentId);

        if (!agentPlan) {
            const errorMsg = `Agent with ID "${agentId}" not found.`;
            logger.onAgentEnd({ runId, status: 'failed', error: errorMsg });
            return;
        }

        // 填充从前端接收到的参数值
        agentPlan.parameters.forEach(param => {
            if (userInputs[param.name] !== undefined) {
                param.value = userInputs[param.name];
            }
        });

        const statsTracker = new StatsTracker();

        const context: AgentContext = {
            logger,
            llmService: this.llmService,
            toolRegistry: this.toolRegistry,
            modelConfig,
            statsTracker // 注入到上下文中

        };

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            logger.onAgentEnd({ runId, status: 'failed', error: 'No workspace folder open.' });
            return;
        }

        // --- 核心逻辑重构 ---
        let finalOutput: any = "执行成功"; // 默认成功消息

        try {
            this.activeRuns.set(runId, { logger }); // 注册运行

            switch (agentId) {
                case 'docgen-project': {
                    const projPrompts = {
                        plannerPrompt: await loadPromptFile(workspaceRoot, 'project_planner.yml'),
                        directAnalysisPrompt: await loadPromptFile(workspaceRoot, 'module_analysis_direct.yml'),
                        mapReduceAnalysisPrompt: await loadPromptFile(workspaceRoot, 'module_analysis_mapreduce.yml'),
                        synthesisPrompt: await loadPromptFile(workspaceRoot, 'project_synthesis.yml'),
                    };
                    const orchestrator = new ProjectDocumentationOrchestrator(context, projPrompts);
                    // Orchestrator 只负责执行，不负责上报最终状态
                    await orchestrator.run(runId);
                    break;
                }

                case 'docgen-module-direct': {
                    const directPromptYaml = await loadPromptFile(workspaceRoot, 'module_analysis_direct.yml');
                    const modulePathParam = agentPlan.parameters.find(p => p.name === 'module_path');
                    if (!modulePathParam || !modulePathParam.value) {
                        throw new Error("Missing required parameter: module_path");
                    }
                    const directInputs = { module_path: modulePathParam.value };

                    const toolchainExecutor = new ToolChainExecutor(context);
                    // 捕获执行器的结果作为 finalOutput
                    finalOutput = await toolchainExecutor.run(runId, directPromptYaml, directInputs);
                    break;
                }

                case 'docgen-module-mapreduce': {
                    const mapreducePromptYaml = await loadPromptFile(workspaceRoot, 'module_analysis_mapreduce.yml');
                    const modulePathParam = agentPlan.parameters.find(p => p.name === 'module_path');
                    if (!modulePathParam || !modulePathParam.value) {
                        throw new Error("Missing required parameter: module_path");
                    }
                    const mapreduceInputs = { module_path: modulePathParam.value };

                    const mapReduceExecutor = new MapReduceExecutor(context);
                    // 捕获执行器的结果作为 finalOutput
                    finalOutput = await mapReduceExecutor.run(runId, mapreducePromptYaml, mapreduceInputs);
                    break;
                }

                default:
                    throw new Error(`Execution for agent "${agentId}" is not yet implemented.`);
            }

            // 只有在运行没有被取消的情况下，才发送 'completed' 事件
            if (this.activeRuns.has(runId)) {
                const finalStats = statsTracker.getFinalStats();
                logger.onAgentEnd({ runId, status: 'completed', finalOutput, stats: finalStats });
            }

        } catch (error: any) {
            // 只有在运行没有被取消的情况下，才发送 'failed' 事件
            if (this.activeRuns.has(runId)) {
                const finalStats = statsTracker.getFinalStats();
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.onAgentEnd({ runId, status: 'failed', error: errorMessage, stats: finalStats });
            }
        } finally {
            this.activeRuns.delete(runId); // 确保在所有路径上都取消注册
        }
    }

    public async runProjectDocumentation(modelConfig: ModelConfig) {
        const logger = new VscodeOutputChannelLogger("CodeWiki Project Documentation");
        await this.prepareAndRunAgent('docgen-project', {}, modelConfig, logger);
    }

    public async runActionFromWebview(
        yamlContent: string,
        userInputs: Record<string, any>,
        modelConfig: ModelConfig,
        webview: vscode.Webview
    ) {
        const logger = new WebviewLogger(webview);
        const statsTracker = new StatsTracker(); // <-- 为 webview action 也创建 tracker
        const context: AgentContext = {
            logger,
            llmService: this.llmService,
            toolRegistry: this.toolRegistry,
            modelConfig,
            statsTracker,
        };
        const runId = uuidv4();

        try {

            this.activeRuns.set(runId, { logger });

            const executor = new ToolChainExecutor(context);
            const result = await executor.run(runId, yamlContent, userInputs);


            if (this.activeRuns.has(runId)) {
                const finalStats = statsTracker.getFinalStats();
                logger.onAgentEnd({ runId, status: 'completed', finalOutput: result, stats: finalStats });
            }


        } catch (error: any) {

            if (this.activeRuns.has(runId)) {
                const finalStats = statsTracker.getFinalStats();
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.onAgentEnd({ runId, status: 'failed', error: errorMessage, stats: finalStats });
            }

        } finally {

            this.activeRuns.delete(runId);

        }
    }
}