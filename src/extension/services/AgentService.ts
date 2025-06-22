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
            { name: "执行工具链", description: "按顺序执行文件读取和分析工具。", promptFiles: ['module_analysis_direct.yml'] },
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
            { name: "准备: 文件分批", description: "扫描指定路径下的所有文件并根据Token限制进行分批。" },
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
    
    constructor(private llmService: LLMService) {
        this.toolRegistry = new ToolRegistry(this.llmService);
    }
    
    public async initialize(defaultModelConfig: ModelConfig): Promise<void> {
        await this.toolRegistry.initialize(defaultModelConfig);
        console.log("AgentService initialized successfully.");
    }

    public async prepareAndRunAgent(
        agentId: string,
        userInput: string,
        modelConfig: ModelConfig,
        logger: AgentLogger
    ) {
        const runId = uuidv4();
        const agentPlan = AGENT_DEFINITIONS[agentId];
        if (!agentPlan) {
            const errorMsg = `Agent with ID "${agentId}" not found.`;
            logger.onAgentEnd({ runId, status: 'failed', error: errorMsg });
            return;
        }
        
        // TODO: 解析 userInput 并填充 agentPlan.parameters
        
        logger.onPlanGenerated(agentPlan);
        
        const context: AgentContext = {
            logger,
            llmService: this.llmService,
            toolRegistry: this.toolRegistry,
            modelConfig,
        };
        
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            logger.onAgentEnd({ runId, status: 'failed', error: 'No workspace folder open.' });
            return;
        }

        try {
            switch (agentId) {
                case 'docgen-project':
                    const projPrompts = {
                        plannerPrompt: await loadPromptFile(workspaceRoot, 'project_planner.yml'),
                        directAnalysisPrompt: await loadPromptFile(workspaceRoot, 'module_analysis_direct.yml'),
                        mapReduceAnalysisPrompt: await loadPromptFile(workspaceRoot, 'module_analysis_mapreduce.yml'),
                        synthesisPrompt: await loadPromptFile(workspaceRoot, 'project_synthesis.yml'),
                    };
                    const orchestrator = new ProjectDocumentationOrchestrator(context, projPrompts);
                    // 修正：传入 runId
                    await orchestrator.run(runId);
                    break;
                
                case 'docgen-module-direct':
                    const directPromptYaml = await loadPromptFile(workspaceRoot, 'module_analysis_direct.yml');
                    // 修正：准备 userInputs
                    const directInputs = { module_path: agentPlan.parameters.find(p => p.name === 'module_path')?.value || '' };
                    const toolchainExecutor = new ToolChainExecutor(context);
                    // 修正：传入 runId, yaml, 和 userInputs
                    const directResult = await toolchainExecutor.run(runId, directPromptYaml, directInputs);
                    logger.onAgentEnd({ runId, status: 'completed', finalOutput: directResult });
                    break;

                case 'docgen-module-mapreduce':
                    const mapreducePromptYaml = await loadPromptFile(workspaceRoot, 'module_analysis_mapreduce.yml');
                    // 修正：准备 userInputs
                    const mapreduceInputs = { module_path: agentPlan.parameters.find(p => p.name === 'module_path')?.value || '' };
                    const mapReduceExecutor = new MapReduceExecutor(context);
                    // 修正：传入 runId, yaml, 和 userInputs
                    const mapreduceResult = await mapReduceExecutor.run(runId, mapreducePromptYaml, mapreduceInputs);
                    logger.onAgentEnd({ runId, status: 'completed', finalOutput: mapreduceResult });
                    break;

                default:
                    logger.onAgentEnd({ runId, status: 'failed', error: `Execution for agent "${agentId}" is not yet implemented.` });
            }
        } catch (error: any) {
            logger.onAgentEnd({ runId, status: 'failed', error: error.message });
        }
    }

    public async runProjectDocumentation(modelConfig: ModelConfig) {
        const logger = new VscodeOutputChannelLogger("CodeWiki Project Documentation");
        await this.prepareAndRunAgent('docgen-project', '', modelConfig, logger);
    }
    
    public async runActionFromWebview(
        yamlContent: string, 
        userInputs: Record<string, any>, 
        modelConfig: ModelConfig,
        webview: vscode.Webview
    ) {
        const logger = new WebviewLogger(webview);
        const context: AgentContext = {
            logger,
            llmService: this.llmService,
            toolRegistry: this.toolRegistry,
            modelConfig
        };
        const runId = uuidv4();

        try {
            const executor = new ToolChainExecutor(context);
            // 修正：传入 runId, yaml, 和 userInputs
            const result = await executor.run(runId, yamlContent, userInputs);
            logger.onAgentEnd({ runId, status: 'completed', finalOutput: result });

        } catch (error: any) {
            if (!(error as any).__logged) {
                logger.onAgentEnd({ runId, status: 'failed', error: error.message });
            }
        }
    }
}