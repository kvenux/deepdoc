// src/extension/agents/orchestrators/ProjectDocumentationOrchestrator.ts (修改后完整文件)

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { AgentContext } from '../AgentContext';
import { MapReduceExecutor } from '../executors/MapReduceExecutor';
import { ToolChainExecutor } from '../executors/ToolChainExecutor';

interface Module {
    name: string;
    path: string;
    description: string;
}

interface PlannerOutput {
    projectName: string;
    language: string;
    modules: Module[];
}

interface ModuleDoc extends Module {
    content: string;
}

interface PromptsCollection {
    plannerPrompt: string;
    directAnalysisPrompt: string;
    mapReduceAnalysisPrompt: string;
    synthesisPrompt: string;
}

export class ProjectDocumentationOrchestrator {
    private readonly MAX_TOKENS_FOR_DIRECT_ANALYSIS = 32000;
    private tokenizer: Tiktoken;
    private runDir!: vscode.Uri; 

    constructor(
        private readonly context: AgentContext,
        private readonly prompts: PromptsCollection
    ) {
        this.tokenizer = get_encoding("cl100k_base");
    }

    public async run() {
        const { logger } = this.context;
        logger.show(true);
        logger.info("--- [启动] 项目文档生成工作流 ---");
        
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("请先打开一个工作区文件夹。");
        }

        try {
            const runId = `doc-gen_${this.context.modelConfig.id.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
            this.runDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki', 'runs', runId);
            await vscode.workspace.fs.createDirectory(this.runDir);
            logger.info(`日志和结果将保存在: ${this.runDir.fsPath}`);

            const plan = await this.runPlanningPhase();
            const moduleDocs = await this.runModuleAnalysisPhase(plan);
            const finalDoc = await this.runSynthesisPhase(plan, moduleDocs);
            
            await this.saveFinalDocument(finalDoc);
            logger.info("\n--- [完成] ---");
            logger.info(`项目文档已成功生成！`);

        } catch (error: any) {
            logger.error("文档生成工作流失败", error);
            vscode.window.showErrorMessage(`文档生成失败: ${error.message}`);
        } finally {
            this.tokenizer.free();
        }
    }
    
    private async runPlanningPhase(): Promise<PlannerOutput> {
        const { logger, toolRegistry, llmService, modelConfig } = this.context;
        logger.info("\n[阶段 1/3] 规划: 分析项目结构...");

        const treeTool = toolRegistry.getTool('get_directory_tree')!;
        const fileTree = await treeTool.call({ path: '.', language: 'unknown' });
        
        logger.info("> 正在调用LLM进行项目规划...");
        const plannerLlm = await llmService.createModel({ modelConfig, temperature: 0.1 });
        const plannerPromptTemplate = (yaml.load(this.prompts.plannerPrompt) as any).llm_prompt_template.human;
        const prompt = plannerPromptTemplate.replace('{file_tree}', fileTree);
        
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '01_planning_request.txt'),
            Buffer.from(prompt, 'utf8')
        );

        const response = await llmService.scheduleLlmCall(() => plannerLlm.invoke([new HumanMessage(prompt)]));
        const responseContent = response.content as string;

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '01_planning_response.txt'),
            Buffer.from(responseContent, 'utf8')
        );
        
        try {
            const jsonString = responseContent.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonString) throw new Error("大模型未能返回有效的JSON规划。");
            
            const plan = JSON.parse(jsonString) as PlannerOutput;

            await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(this.runDir, 'plan.json'),
                Buffer.from(JSON.stringify(plan, null, 2), 'utf8')
            );
            
            logger.info(`- 规划完成，识别出 ${plan.modules.length} 个模块。`);
            return plan;
        } catch (e: any) {
            throw new Error(`解析规划输出失败: ${e.message}`);
        }
    }

    // ================================================================
    // ==================== 核心修改在这里 ====================
    // ================================================================
    private async runModuleAnalysisPhase(plan: PlannerOutput): Promise<ModuleDoc[]> {
        const { logger } = this.context;
        logger.info("\n[阶段 2/3] 过滤和验证模块...");

        // 1. 标准化和初步过滤
        let modules = plan.modules
            .map(m => ({
                ...m,
                // 标准化路径：移除前后斜杠和空格，并将 '.' 转换为空字符串以便后续处理
                normalizedPath: m.path.trim().replace(/^\.?[\\\/]/, '').replace(/[\\\/]$/, '')
            }))
            .filter(m => m.normalizedPath !== ''); // 过滤掉空路径或只包含'.'的路径
        
        // 2. 按路径长度从长到短排序，这样我们总是先处理最具体的子目录
        modules.sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);

        // 3. 检测并移除重叠路径
        const uniqueModules: typeof modules = [];
        const coveredPaths = new Set<string>();

        for (const currentModule of modules) {
            let isCovered = false;
            // 检查当前模块路径是否已经包含在更具体的路径中
            for (const coveredPath of coveredPaths) {
                // 如果 'agile-console/src' 在集合中，而当前路径是 'agile-console'
                if (coveredPath.startsWith(currentModule.normalizedPath + '/')) {
                    isCovered = true;
                    break;
                }
            }

            if (!isCovered) {
                uniqueModules.push(currentModule);
                coveredPaths.add(currentModule.normalizedPath);
            } else {
                logger.warn(`- 已跳过模块 '${currentModule.name}' (路径: '${currentModule.path}'),因为它包含了已被分析的更具体的子模块。`);
            }
        }
        
        const finalModules = uniqueModules.reverse(); // 恢复原始顺序或按字母排序以便阅读

        if (finalModules.length < plan.modules.length) {
            const skippedCount = plan.modules.length - finalModules.length;
            logger.info(`- 过滤完成，共跳过 ${skippedCount} 个无效或重叠的模块。`);
        }
        logger.info(`- 将分析 ${finalModules.length} 个唯一的模块。`);


        logger.info("\n[阶段 2.5] 执行: 并行分析所有有效模块...");
        const analysisPromises = finalModules.map((module, index) => 
            this.analyzeSingleModule(module, plan.language, index + 1, finalModules.length)
        );
        const results = await Promise.all(analysisPromises);
        logger.info("- 所有有效模块分析完成。");
        return results;
    }
    // ================================================================
    // ================================================================

    private async analyzeSingleModule(module: Module, language: string, index: number, total: number): Promise<ModuleDoc> {
        const { logger } = this.context;
        logger.info(`\n> [模块 ${index}/${total}] 开始分析 '${module.name}' (路径: '${module.path}')...`);
        
        const moduleAnalysisDir = vscode.Uri.joinPath(this.runDir, `module_analysis_${module.path.replace(/[\/\\]/g, '_')}`);
        await vscode.workspace.fs.createDirectory(moduleAnalysisDir);

        const moduleContext: AgentContext = {
            ...this.context,
            runDir: moduleAnalysisDir 
        };
        
        const contentTool = this.context.toolRegistry.getTool('get_all_files_content') as any;
        const allContent = await contentTool.call({ path: module.path, language });
        const tokenCount = this.tokenizer.encode(allContent).length;
        logger.info(`  - Token总数: ${tokenCount}`);
        
        let executor: ToolChainExecutor | MapReduceExecutor;
        let promptYaml: string;

        if (tokenCount <= this.MAX_TOKENS_FOR_DIRECT_ANALYSIS) {
            logger.info(`  - 使用直接分析策略 (ToolChain)`);
            executor = new ToolChainExecutor(moduleContext);
            promptYaml = this.prompts.directAnalysisPrompt;
        } else {
            logger.info(`  - Token数超出限制，使用Map-Reduce策略`);
            executor = new MapReduceExecutor(moduleContext);
            promptYaml = this.prompts.mapReduceAnalysisPrompt;
        }

        const docContent = await executor.run(promptYaml, { module_path: module.path, language, task_description: module.description });

        const moduleDocPath = vscode.Uri.joinPath(this.runDir, `module_${module.name.replace(/[\s\/]/g, '_')}.md`);
        await vscode.workspace.fs.writeFile(moduleDocPath, Buffer.from(docContent, 'utf8'));
        
        return { ...module, content: docContent };
    }

    private async runSynthesisPhase(plan: PlannerOutput, moduleDocs: ModuleDoc[]): Promise<string> {
        const { logger, llmService, modelConfig } = this.context;
        logger.info("\n[阶段 3/3] 综合: 生成最终文档...");

        const synthesisLlm = await llmService.createModel({ modelConfig, temperature: 0.4 });
        const synthesisPromptTemplate = (yaml.load(this.prompts.synthesisPrompt) as any).llm_prompt_template.human;

        const moduleOverviews = moduleDocs.map(m => `- **${m.name} (${m.path})**: ${m.description}`).join('\n');
        const detailedModuleDocs = moduleDocs.map((doc, index) => `
### 模块: ${doc.name}
${doc.content}
`).join('\n---\n');

        const prompt = synthesisPromptTemplate
            .replace('{projectName}', plan.projectName)
            .replace('{language}', plan.language)
            .replace('{module_overviews}', moduleOverviews)
            .replace('{detailed_module_docs}', detailedModuleDocs);
            
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_request.txt'),
            Buffer.from(prompt, 'utf8')
        );

        logger.info("> 正在调用LLM进行最终综合...");
        const response = await llmService.scheduleLlmCall(() => synthesisLlm.invoke([new HumanMessage(prompt)]));
        const responseContent = response.content as string;

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_response.txt'),
            Buffer.from(responseContent, 'utf8')
        );

        logger.info("- 最终文档综合完成。");
        return responseContent;
    }

    private async saveFinalDocument(content: string) {
        const finalDocPath = vscode.Uri.joinPath(this.runDir, '项目总体设计文档.md');
        await vscode.workspace.fs.writeFile(finalDocPath, Buffer.from(content, 'utf8'));
        
        vscode.window.showInformationMessage(`文档已保存至: ${finalDocPath.fsPath}`, '打开文件').then(selection => {
            if (selection === '打开文件') {
                vscode.window.showTextDocument(finalDocPath);
            }
        });
    }
}