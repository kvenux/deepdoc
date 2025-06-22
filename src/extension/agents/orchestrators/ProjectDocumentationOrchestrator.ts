import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { v4 as uuidv4 } from 'uuid'; // 修正：添加 import
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers'; // 修正：添加 import
import { AgentContext } from '../AgentContext';
import { MapReduceExecutor } from '../executors/MapReduceExecutor';
import { ToolChainExecutor } from '../executors/ToolChainExecutor';

// 接口定义
interface Module {
    name: string;
    path: string;
    description: string;
    // 修正：为去重逻辑添加临时属性
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
    // 修正：移除 runId 作为类属性，改为参数传递

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

            // 修正：将 runId 作为参数传递
            const plan = await this.runPlanningPhase(runId);
            const moduleDocs = await this.runModuleAnalysisPhase(runId, plan);
            const finalDoc = await this.runSynthesisPhase(runId, plan, moduleDocs);
            
            await this.saveFinalDocument(finalDoc);
            logger.onAgentEnd({ runId, status: 'completed', finalOutput: finalDoc });

        } catch (error: any) {
            logger.onAgentEnd({ runId, status: 'failed', error: error.message });
            vscode.window.showErrorMessage(`文档生成失败: ${error.message}`);
        } finally {
            this.tokenizer.free();
        }
    }
    
    private async runPlanningPhase(runId: string): Promise<PlannerOutput> {
        const { logger, toolRegistry, llmService, modelConfig } = this.context;
        const taskId = uuidv4();
        const stepName = "规划: 分析项目结构";
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        const treeTool = toolRegistry.getTool('get_directory_tree')!;
        const fileTree = await treeTool.call({ path: '.', language: 'unknown' }) as string;
        logger.onStepUpdate({ runId, taskId, type: 'input', data: { name: "文件树", content: fileTree } });

        const plannerLlm = await llmService.createModel({ modelConfig, temperature: 0.1 });
        const plannerPromptTemplate = (yaml.load(this.prompts.plannerPrompt) as any).llm_prompt_template.human;
        const prompt = plannerPromptTemplate.replace('{file_tree}', fileTree);
        logger.onStepUpdate({ runId, taskId, type: 'llm-request', data: { system: "...", human: prompt }});

        // --- 恢复写入 planning request ---
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '01_planning_request.txt'),
            Buffer.from(prompt, 'utf8')
        );

        const response = await llmService.scheduleLlmCall(() => plannerLlm.invoke([new HumanMessage(prompt)]));
        const responseContent = response.content as string;

        // --- 恢复写入 planning response ---
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '01_planning_response.txt'),
            Buffer.from(responseContent, 'utf8')
        );

        try {
            const jsonString = responseContent.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonString) throw new Error("大模型未能返回有效的JSON规划。");
            
            const plan = JSON.parse(jsonString) as PlannerOutput;

            logger.onStepUpdate({ runId, taskId, type: 'output', data: { name: "项目规划", content: plan } });
            logger.onStepEnd({ runId, taskId, status: 'completed' });
            return plan;
        } catch (e: any) {
            logger.onStepEnd({ runId, taskId, status: 'failed', error: e.message });
            throw new Error(`解析规划输出失败: ${e.message}`);
        }
    }

    private async runModuleAnalysisPhase(runId: string, plan: PlannerOutput): Promise<ModuleDoc[]> {
        const { logger, llmService, toolRegistry } = this.context; // 修正：从 this.context 获取
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder open.");
        }

        const filterTaskId = uuidv4();
        const filterStepName = "过滤和验证模块";
        logger.onStepStart({ runId, taskId: filterTaskId, stepName: filterStepName, status: 'running' });

        // --- 过滤逻辑：增加文件路径和根目录过滤 ---

        // 1. 异步过滤：检查路径有效性（是否存在且为目录）
        const pathCheckPromises = plan.modules.map(async (m) => {
            const modulePath = m.path.trim();

            // 硬编码规则 1: 跳过根目录
            if (modulePath === '.' || modulePath === './' || modulePath === '' || modulePath === '/') {
                logger.warn(`- 已跳过模块 '${m.name}' (路径: '${m.path}'), 因其指向根目录。`);
                return null;
            }

            try {
                const absoluteUri = vscode.Uri.joinPath(workspaceRoot, modulePath);
                const stat = await vscode.workspace.fs.stat(absoluteUri);

                // 硬编码规则 2: 必须是目录
                if (stat.type !== vscode.FileType.Directory) {
                    logger.warn(`- 已跳过模块 '${m.name}' (路径: '${m.path}'), 因其指向单个文件而非目录。`);
                    return null;
                }
                
                // 路径有效，返回该模块
                return m;
            } catch (error) {
                // 路径不存在
                logger.warn(`- 已跳过模块 '${m.name}' (路径: '${m.path}'), 因路径不存在。`);
                return null;
            }
        });

        const validDirectoryModules = (await Promise.all(pathCheckPromises)).filter((m): m is Module => m !== null);
        
        // 2. 标准化剩余模块的路径
        let modules = validDirectoryModules.map(m => ({
            ...m,
            normalizedPath: m.path.trim().replace(/^\.?[\\\/]/, '').replace(/[\\\/]$/, '')
        }));

        // 3. 对剩余的目录路径进行重叠检查（逻辑保持不变）
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
            modules: finalModules.map(({ normalizedPath, ...rest }) => rest) // 移除临时的 normalizedPath 属性
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
        logger.onStepEnd({ runId, taskId: filterTaskId, status: 'completed' });
        
        const analysisStepName = "执行: 并行分析所有有效模块";
        logger.onStepStart({ runId, stepName: analysisStepName, status: 'running' });
        const analysisPromises = finalModules.map((module, index) => 
            this.analyzeSingleModule(runId, module, plan.language, index + 1, finalModules.length)
        );
        const results = await Promise.all(analysisPromises);
        logger.onStepEnd({ runId, status: 'completed' });
        return results;
    }
    
    private async analyzeSingleModule(runId: string, module: Module, language: string, index: number, total: number): Promise<ModuleDoc> {
        const { logger } = this.context;
        const taskId = uuidv4();
        const stepName = `分析模块: '${module.name}' (${index}/${total})`;
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

        const docContent = await executor.run(runId, promptYaml, { module_path: module.path, language, task_description: module.description });
        
        const docPath = vscode.Uri.joinPath(this.runDir, `module_${module.name.replace(/[\s\/]/g, '_')}.md`);
        await vscode.workspace.fs.writeFile(docPath, Buffer.from(docContent, 'utf8'));
        
        logger.onStepUpdate({ runId, taskId, type: 'output', data: { name: "模块文档", content: docContent }, metadata: { type: 'file', path: docPath.fsPath } });
        logger.onStepEnd({ runId, taskId, status: 'completed' });

        return { ...module, content: docContent };
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

        // --- 恢复写入 synthesis request ---
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
            logger.onStreamChunk({ runId, taskId, content: chunkContent });
        }

        // --- 恢复写入 synthesis response ---
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_response.txt'),
            Buffer.from(finalDoc, 'utf8')
        );
        
        logger.onStepUpdate({ runId, taskId, type: 'output', data: { name: "最终项目文档", content: finalDoc }, metadata: { type: 'markdown' } });
        logger.onStepEnd({ runId, taskId, status: 'completed' });
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