// src/extension/services/AgentService.ts (完整文件)

import * as vscode from 'vscode';
import { ModelConfig } from '../../common/types';
import { AgentContext } from '../agents/AgentContext';
import { ProjectDocumentationOrchestrator } from '../agents/orchestrators/ProjectDocumentationOrchestrator';
import { ToolChainExecutor } from '../agents/executors/ToolChainExecutor';
import { AgentLogger, VscodeOutputChannelLogger, WebviewLogger } from './logging';
import { LLMService } from './LLMService';
import { ToolRegistry } from './ToolRegistry';

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
    
    /**
     * 在扩展激活时调用，初始化所有服务。
     * @param defaultModelConfig 默认的模型配置。
     */
    public async initialize(defaultModelConfig: ModelConfig): Promise<void> {
        await this.toolRegistry.initialize(defaultModelConfig);
        console.log("AgentService initialized successfully.");
    }

    /**
     * 运行完整的项目文档生成工作流。
     * @param modelConfig 用于此次运行的模型配置。
     */
    public async runProjectDocumentation(modelConfig: ModelConfig) {
        // 1. 创建 UI 相关的 Logger
        const logger = new VscodeOutputChannelLogger("CodeWiki Project Documentation");
        
        // 2. 创建 Agent 上下文
        const context: AgentContext = {
            logger,
            llmService: this.llmService,
            toolRegistry: this.toolRegistry,
            modelConfig,
        };

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            logger.error("No workspace folder open.");
            return;
        }

        try {
            // 3. 加载所需的提示词
            const prompts = {
                plannerPrompt: await loadPromptFile(workspaceRoot, 'project_planner.yml'),
                directAnalysisPrompt: await loadPromptFile(workspaceRoot, 'module_analysis_direct.yml'),
                mapReduceAnalysisPrompt: await loadPromptFile(workspaceRoot, 'module_analysis_mapreduce.yml'),
                synthesisPrompt: await loadPromptFile(workspaceRoot, 'project_synthesis.yml'),
            };

            // 4. 实例化并运行编排器
            const orchestrator = new ProjectDocumentationOrchestrator(context, prompts);
            await orchestrator.run();

        } catch (error: any) {
            logger.error("Failed to start Project Documentation agent", error);
            vscode.window.showErrorMessage(`Agent startup failed: ${error.message}`);
        }
    }
    
    /**
     * 从Webview运行一个Action Prompt。
     * @param yamlContent YAML 定义。
     * @param userInputs 用户输入。
     * @param modelConfig 模型配置。
     * @param webview 触发此操作的Webview实例。
     */
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

        try {
            // TODO: 这里可以添加逻辑来判断YAML类型，选择不同的Executor。
            // 目前我们只实现了ToolChainExecutor。
            const executor = new ToolChainExecutor(context);
            await executor.run(yamlContent, userInputs);

        } catch (error: any) {
            logger.error("Failed to run action from webview", error);
        }
    }
}