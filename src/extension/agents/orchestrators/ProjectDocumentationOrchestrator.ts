// file_path: extension/agents/orchestrators/ProjectDocumentationOrchestrator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { v4 as uuidv4 } from 'uuid';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { AgentContext } from '../AgentContext';
import { MapReduceExecutor } from '../executors/MapReduceExecutor';
import { ToolChainExecutor } from '../executors/ToolChainExecutor';

// 接口定义
interface Module {
    name: string;
    path: string;
    description: string;
    normalizedPath?: string;
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
    private tokenizer!: Tiktoken;
    private runDir!: vscode.Uri;

    constructor(
        private readonly context: AgentContext,
        private readonly prompts: PromptsCollection
    ) {}

    public async run(runId: string) {
        this.tokenizer = get_encoding("cl100k_base");

        const { logger } = this.context;
        logger.show(true);

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("请先打开一个工作区文件夹。");
        }

        try {
            const runFolderName = `doc-gen_${new Date().toISOString().replace(/[:.]/g, '-')}`;
            this.runDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki', 'runs', runFolderName);
            await vscode.workspace.fs.createDirectory(this.runDir);
            logger.info(`日志和结果将保存在: ${this.runDir.fsPath}`);

            const plan = await this.runPlanningPhase(runId);
            const moduleDocs = await this.runModuleAnalysisPhase(runId, plan);
            const finalDoc = await this.runSynthesisPhase(runId, plan, moduleDocs);

            await this.saveFinalDocument(finalDoc);
            
            // --- 修改点 1: 简化 agent 最终结果 ---
            // 不再发送完整的文档内容，只发送一个简单的成功消息。
            logger.onAgentEnd({ runId, status: 'completed', finalOutput: "执行成功" });

        } catch (error: any) {
            logger.onAgentEnd({ runId, status: 'failed', error: error.message });
            vscode.window.showErrorMessage(`文档生成失败: ${error.message}`);
        } finally {
            if (this.tokenizer) { 
               this.tokenizer.free();
            }
        }
    }

    private async runPlanningPhase(runId: string): Promise<PlannerOutput> {
        const { logger, toolRegistry, llmService, modelConfig } = this.context;
        const taskId = uuidv4();
        const stepName = "规划: 分析项目结构"; // This is the stepName
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        const treeTool = toolRegistry.getTool('get_directory_tree')!;
        const fileTree = await treeTool.call({ path: '.', language: 'unknown' }) as string;
        logger.onStepUpdate({ runId, taskId, type: 'input', data: { name: "文件树", content: fileTree } });

        const plannerLlm = await llmService.createModel({ modelConfig, temperature: 0.1 });
        const plannerPromptTemplate = (yaml.load(this.prompts.plannerPrompt) as any).llm_prompt_template.human;
        const prompt = plannerPromptTemplate.replace('{file_tree}', fileTree);
        logger.onStepUpdate({ runId, taskId, type: 'llm-request', data: { system: "...", human: prompt }});

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

            logger.onStepUpdate({ runId, taskId, type: 'output', data: { name: "项目规划", content: plan } });
            // highlight-start
            logger.onStepEnd({ runId, taskId, stepName, status: 'completed' });
            // highlight-end
            return plan;
        } catch (e: any) {
            // highlight-start
            logger.onStepEnd({ runId, taskId, stepName, status: 'failed', error: e.message });
            // highlight-end
            throw new Error(`解析规划输出失败: ${e.message}`);
        }
    }

    private async runModuleAnalysisPhase(runId: string, plan: PlannerOutput): Promise<ModuleDoc[]> {
        const { logger, llmService, toolRegistry } = this.context;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder open.");
        }

        const filterTaskId = uuidv4();
        const filterStepName = "过滤和验证模块";
        logger.onStepStart({ runId, taskId: filterTaskId, stepName: filterStepName, status: 'running' });

        const pathCheckPromises = plan.modules.map(async (m) => {
            const modulePath = m.path.trim();
            if (modulePath === '.' || modulePath === './' || modulePath === '' || modulePath === '/') {
                logger.warn(`- 已跳过模块 '${m.name}' (路径: '${m.path}'), 因其指向根目录。`);
                return null;
            }
            try {
                const absoluteUri = vscode.Uri.joinPath(workspaceRoot, modulePath);
                const stat = await vscode.workspace.fs.stat(absoluteUri);
                if (stat.type !== vscode.FileType.Directory) {
                    logger.warn(`- 已跳过模块 '${m.name}' (路径: '${m.path}'), 因其指向单个文件而非目录。`);
                    return null;
                }
                return m;
            } catch (error) {
                logger.warn(`- 已跳过模块 '${m.name}' (路径: '${m.path}'), 因路径不存在。`);
                return null;
            }
        });

        const validDirectoryModules = (await Promise.all(pathCheckPromises)).filter((m): m is Module => m !== null);

        let modules = validDirectoryModules.map(m => ({
            ...m,
            normalizedPath: m.path.trim().replace(/^\.?[\\\/]/, '').replace(/[\\\/]$/, '')
        }));

        modules.sort((a, b) => (b.normalizedPath?.length || 0) - (a.normalizedPath?.length || 0));

        const finalModules: Module[] = [];
        const coveredPaths = new Set<string>();

        for (const currentModule of modules) {
            if (!currentModule.normalizedPath) continue;
            let isCovered = false;
            for (const coveredPath of coveredPaths) {
                if (coveredPath.startsWith(currentModule.normalizedPath + '/')) {
                    isCovered = true;
                    break;
                }
            }
            if (!isCovered) {
                finalModules.push(currentModule);
                coveredPaths.add(currentModule.normalizedPath);
            } else {
                 logger.warn(`- 跳过模块 '${currentModule.name}' (路径: '${currentModule.path}'), 因其包含已被选中的更具体的子模块。`);
            }
        }

        finalModules.reverse();

        const finalPlan: PlannerOutput = {
            ...plan,
            modules: finalModules.map(({ normalizedPath, ...rest }) => rest)
        };

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, 'plan.json'),
            Buffer.from(JSON.stringify(finalPlan, null, 2), 'utf8')
        );


        if (finalModules.length < plan.modules.length) {
            const skippedCount = plan.modules.length - finalModules.length;
            logger.info(`- 过滤完成，共跳过 ${skippedCount} 个根目录、文件路径或重叠的模块。`);
        } else {
            logger.info(`- 所有模块路径均为有效目录且不重叠，将分析全部 ${finalModules.length} 个模块。`);
        }

        logger.onStepUpdate({ runId, taskId: filterTaskId, type: 'output', data: { name: "唯一模块", content: `已过滤，将分析 ${finalModules.length} 个模块。` } });
        // highlight-start
        logger.onStepEnd({ runId, taskId: filterTaskId, stepName: filterStepName, status: 'completed' });
        // highlight-end

        const analysisStepName = "分析: 并行处理模块";
        logger.info(`[DEBUG] Attempting to start parent step: ${analysisStepName}`);
        logger.onStepStart({ runId, stepName: analysisStepName, status: 'running' }); 
        const analysisPromises = finalModules.map((module, index) =>
            this.analyzeSingleModule(runId, module, plan.language, index + 1, finalModules.length)
        );
        const results = await Promise.all(analysisPromises);
        // highlight-start
        logger.onStepEnd({ runId, stepName: analysisStepName, status: 'completed' }); // This is the parent step for module analysis
        // highlight-end
        return results;
    }

    private async analyzeSingleModule(runId: string, module: Module, language: string, index: number, total: number): Promise<ModuleDoc> {
        const { logger } = this.context;
        const taskId = uuidv4();
        const stepName = `分析模块: '${module.name}' (${index}/${total})`;
        logger.info(`[DEBUG] Attempting to start sub-step: ${stepName} with taskId: ${taskId}`);
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        const moduleAnalysisDir = vscode.Uri.joinPath(this.runDir, `module_${module.path.replace(/[\/\\]/g, '_')}`);
        await vscode.workspace.fs.createDirectory(moduleAnalysisDir);

        const moduleContext: AgentContext = { ...this.context, runDir: moduleAnalysisDir };

        const contentTool = this.context.toolRegistry.getTool('get_all_files_content') as any;
        const allContent = await contentTool.call({ path: module.path, language }) as string;
        const tokenCount = this.tokenizer.encode(allContent).length;

        let executor: ToolChainExecutor | MapReduceExecutor;
        let promptYaml: string;
        let strategy: string;

        if (tokenCount <= this.MAX_TOKENS_FOR_DIRECT_ANALYSIS) {
            strategy = "直接分析 (ToolChain)";
            executor = new ToolChainExecutor(moduleContext);
            promptYaml = this.prompts.directAnalysisPrompt;
        } else {
            strategy = "Map-Reduce分析";
            executor = new MapReduceExecutor(moduleContext);
            promptYaml = this.prompts.mapReduceAnalysisPrompt;
        }
        logger.onStepUpdate({ runId, taskId, type: 'input', data: { name: "分析策略", content: strategy, "Token数": tokenCount } });

        try {
            const docContent = await executor.run(runId, promptYaml, { module_path: module.path, language, task_description: module.description });

            const docPath = vscode.Uri.joinPath(this.runDir, `module_${module.name.replace(/[\s\/]/g, '_')}.md`);
            await vscode.workspace.fs.writeFile(docPath, Buffer.from(docContent, 'utf8'));

            logger.onStepUpdate({ runId, taskId, type: 'output', data: { name: "模块文档", content: docContent }, metadata: { type: 'file', path: docPath.fsPath } });
            // highlight-start
            logger.onStepEnd({ runId, taskId, stepName, status: 'completed' });
            // highlight-end
            return { ...module, content: docContent };
        } catch (e: any) {
            // highlight-start
            logger.onStepEnd({ runId, taskId, stepName, status: 'failed', error: e.message });
            // highlight-end
            throw e; // Re-throw to be caught by the main run() method's try-catch
        }
    }

    private async runSynthesisPhase(runId: string, plan: PlannerOutput, moduleDocs: ModuleDoc[]): Promise<string> {
        const { logger, llmService, modelConfig } = this.context;
        const taskId = uuidv4();
        const stepName = "综合: 生成最终文档";
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        const synthesisLlm = await llmService.createModel({ modelConfig, temperature: 0.4, streaming: true });

        const synthesisPromptTemplate = (yaml.load(this.prompts.synthesisPrompt) as any).llm_prompt_template.human;
        const moduleOverviews = moduleDocs.map(m => `- **${m.name} (${m.path})**: ${m.description}`).join('\n');
        const detailedModuleDocs = moduleDocs.map(doc => `\n### 模块: ${doc.name}\n${doc.content}\n`).join('\n---\n');
        const prompt = synthesisPromptTemplate.replace('{projectName}', plan.projectName).replace('{language}', plan.language).replace('{module_overviews}', moduleOverviews).replace('{detailed_module_docs}', detailedModuleDocs);

        logger.onStepUpdate({ runId, taskId, type: 'llm-request', data: { system: "...", human: prompt }});

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_request.txt'),
            Buffer.from(prompt, 'utf8')
        );

        const chain = synthesisLlm.pipe(new StringOutputParser());
        const stream = await chain.stream([new HumanMessage(prompt)]);

        let finalDoc = '';
        for await (const chunk of stream) {
            const chunkContent = chunk as string;
            finalDoc += chunkContent;
            // logger.onStreamChunk({ runId, taskId, content: chunkContent });
        }

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_response.txt'),
            Buffer.from(finalDoc, 'utf8')
        );

        // 1. 获取最终文档的路径
        const finalDocPath = await this.getFinalDocPath();

        // 2. 发送 StepUpdate，其中 metadata 指向文件路径，data.content 可以是简短描述
        logger.onStepUpdate({ 
            runId, 
            taskId, 
            type: 'output', 
            data: { name: "最终项目文档", content: `文档已生成: ${path.basename(finalDocPath.fsPath)}` },
            metadata: { type: 'file', path: finalDocPath.fsPath } // <-- 这是关键
        });

        logger.onStepEnd({ runId, taskId, stepName, status: 'completed' });
        return finalDoc;
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

     private async getFinalDocPath(): Promise<vscode.Uri> {
        return vscode.Uri.joinPath(this.runDir, '项目总体设计文档.md');
    }
}