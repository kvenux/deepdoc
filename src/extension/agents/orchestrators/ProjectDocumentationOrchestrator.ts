// file_path: extension/agents/orchestrators/ProjectDocumentationOrchestrator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { v4 as uuidv4 } from 'uuid';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { AgentContext } from '../AgentContext';
import { MapReduceExecutor, ExecutorResult } from '../executors/MapReduceExecutor';
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

// 为规划器YML文件定义一个更明确的接口
interface PlannerPromptFile {
    title: string;
    description: string;
    config?: {
        max_tokens_for_direct_analysis?: number;
    };
    llm_prompt_template: {
        system: string;
        human: string;
    };
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
    private maxTokensForDirectAnalysis!: number;
    private tokenizer!: Tiktoken;
    private runDir!: vscode.Uri;

    constructor(
        private readonly context: AgentContext,
        private readonly prompts: PromptsCollection
    ) {
        this.maxTokensForDirectAnalysis = this.context.performanceConfig.maxTokensForDirectAnalysis;
    }


    public async run(runId: string, sourcePath: string) {

        this.tokenizer = get_encoding("cl100k_base");

        const { logger } = this.context;
        logger.show(true);

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("请先打开一个工作区文件夹。");
        }

        // 移除 try/catch, 让错误向上冒泡到 AgentService
        const runFolderName = `doc-gen_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        this.runDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki', 'runs', runFolderName);
        await vscode.workspace.fs.createDirectory(this.runDir);
        logger.info(`日志和结果将保存在: ${this.runDir.fsPath}`);

        logger.info(`开始分析项目文档，目标路径: '${sourcePath}'`);


        const plan = await this.runPlanningPhase(runId, sourcePath);
        const moduleDocs = await this.runModuleAnalysisPhase(runId, plan);
        const finalDoc = await this.runSynthesisPhase(runId, plan, moduleDocs);

        await this.saveFinalDocument(finalDoc);

        // 移除 onAgentEnd 调用。AgentService 将负责此事
        // logger.onAgentEnd({ runId, status: 'completed', finalOutput: "执行成功" });

        if (this.tokenizer) {
            this.tokenizer.free();
        }
    }


    private async runPlanningPhase(runId: string, sourcePath: string): Promise<PlannerOutput> {

        const { logger, toolRegistry, llmService, modelConfig, statsTracker } = this.context; // <-- 添加 statsTracker
        const taskId = uuidv4();
        const stepName = "规划: 分析项目结构"; // This is the stepName
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        // 解析 YAML 文件并读取配置
        const plannerPromptFile = yaml.load(this.prompts.plannerPrompt) as PlannerPromptFile;
        if (plannerPromptFile.config?.max_tokens_for_direct_analysis) {
            this.maxTokensForDirectAnalysis = plannerPromptFile.config.max_tokens_for_direct_analysis;
            logger.info(`从 project_planner.yml 加载配置: max_tokens_for_direct_analysis = ${this.maxTokensForDirectAnalysis}`);
        }

        const treeTool = toolRegistry.getTool('get_directory_tree')!;

        const fileTree = await treeTool.call({ path: sourcePath, language: 'unknown' }) as string;

        logger.onStepUpdate({ runId, taskId, type: 'input', data: { name: "文件树", content: fileTree } });

        const plannerLlm = await llmService.createModel({ modelConfig, temperature: 0.1 });
        const plannerPromptTemplate = (yaml.load(this.prompts.plannerPrompt) as any).llm_prompt_template.human;
        const prompt = plannerPromptTemplate.replace('{file_tree}', fileTree);
        logger.onStepUpdate({ runId, taskId, type: 'llm-request', data: { system: "...", human: prompt } });

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '01_planning_request.txt'),
            Buffer.from(prompt, 'utf8')
        );

        const response = await llmService.scheduleLlmCall(() => plannerLlm.invoke([new HumanMessage(prompt)]));
        const responseContent = response.content as string;

        statsTracker.add(prompt, responseContent); // 记录 Token

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '01_planning_response.txt'),
            Buffer.from(responseContent, 'utf8')
        );

        try {
            const jsonString = responseContent.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonString) throw new Error("大模型未能返回有效的JSON规划。");

            const plan = JSON.parse(jsonString) as PlannerOutput;

            logger.onStepUpdate({ runId, taskId, type: 'output', data: { name: "项目规划", content: plan } });

            logger.onStepEnd({ runId, taskId, stepName, status: 'completed' });

            return plan;
        } catch (e: any) {

            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.onStepEnd({ runId, taskId, stepName, status: 'failed', error: errorMessage });

            throw new Error(`解析规划输出失败: ${e.message}`);
        }
    }


    private async runModuleAnalysisPhase(runId: string, plan: PlannerOutput): Promise<ModuleDoc[]> {
        const { logger, toolRegistry } = this.context;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder open.");
        }

        // 步骤 1: 路径验证和去重（和之前一样）
        const filterStepName = "过滤和验证模块";
        const filterTaskId = uuidv4();
        logger.onStepStart({ runId, taskId: filterTaskId, stepName: filterStepName, status: 'running' });
        // --- (这部分路径检查和去重逻辑保持不变) ---
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
        let modulesWithNormalizedPath = validDirectoryModules.map(m => ({
            ...m,
            normalizedPath: m.path.trim().replace(/^\.?[\\\/]/, '').replace(/[\\\/]$/, '')
        }));
        const finalModulesPreFilter: Module[] = [];
        const candidatePaths = new Set(modulesWithNormalizedPath.map(m => m.normalizedPath).filter((p): p is string => !!p));
        const pathsToRemove = new Set<string>();
        for (const path1 of candidatePaths) {
            for (const path2 of candidatePaths) {
                if (path1 !== path2 && path2.startsWith(path1 + '/')) {
                    pathsToRemove.add(path1);
                }
            }
        }
        const pathsToKeep = new Set([...candidatePaths].filter(p => !pathsToRemove.has(p)));
        for (const module of modulesWithNormalizedPath) {
            if (module.normalizedPath && pathsToKeep.has(module.normalizedPath)) {
                finalModulesPreFilter.push(module);
            } else if (module.normalizedPath) {
                 logger.warn(`- 跳过模块 '${module.name}' (路径: '${module.path}'), 因其是另一个更具体模块的父目录或路径无效。`);
            }
        }
        
        // 步骤 2: 对去重后的模块进行内容预计算和Token过滤
        const contentTool = this.context.toolRegistry.getTool('get_all_files_content') as any;
        const moduleDetailsPromises = finalModulesPreFilter.map(async (module) => {
            const content = await contentTool.call({ path: module.path, language: plan.language }) as string;
            const tokenCount = this.tokenizer.encode(content).length;
            return { ...module, content, tokenCount };
        });

        const allModuleDetails = await Promise.all(moduleDetailsPromises);

        const MIN_TOKEN_THRESHOLD = 1000;
        const analyzableModules = allModuleDetails.filter(details => {
            if (details.tokenCount < MIN_TOKEN_THRESHOLD) {
                logger.info(`- 已过滤模块 '${details.name}' (路径: '${details.path}'), 因其 Token 数 (${details.tokenCount}) 小于 ${MIN_TOKEN_THRESHOLD}。`);
                return false;
            }
            return true;
        });

        const finalPlan: PlannerOutput = {
            ...plan,
            // 只保留通过了所有过滤的模块
            modules: analyzableModules.map(({ content, tokenCount, normalizedPath, ...rest }) => rest)
        };

        // 步骤 3: 将最终确认的、过滤后的计划写入文件
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, 'plan.json'),
            Buffer.from(JSON.stringify(finalPlan, null, 2), 'utf8')
        );

        const originalCount = plan.modules.length;
        const finalCount = analyzableModules.length;
        if (finalCount < originalCount) {
            const skippedCount = originalCount - finalCount;
            logger.info(`- 过滤完成，共跳过 ${skippedCount} 个无效、重叠或Token过少的模块。`);
        } else {
            logger.info(`- 所有模块均有效，将分析全部 ${finalCount} 个模块。`);
        }
        logger.onStepUpdate({ runId, taskId: filterTaskId, type: 'output', data: { name: "最终模块列表", content: `已过滤，将分析 ${finalCount} 个模块。` } });
        logger.onStepEnd({ runId, taskId: filterTaskId, stepName: filterStepName, status: 'completed' });
        
        // 如果所有模块都被过滤掉了，直接返回空数组
        if (analyzableModules.length === 0) {
            return [];
        }

        // 步骤 4: 对过滤后的模块列表进行并行分析
        const analysisStepName = "分析: 并行处理模块";
        logger.info(`[DEBUG] Attempting to start parent step: ${analysisStepName}`);
        logger.onStepStart({ runId, stepName: analysisStepName, status: 'running' });

        const analysisPromises = analyzableModules.map((moduleWithDetails, index) =>
            this.analyzeSingleModule(
                runId,
                moduleWithDetails, // 传递整个对象
                plan.language,
                index + 1,
                analyzableModules.length,
                moduleWithDetails.content,    // 传递预计算的内容
                moduleWithDetails.tokenCount  // 传递预计算的Token数
            )
        );
        const results = await Promise.all(analysisPromises);
        logger.onStepEnd({ runId, stepName: analysisStepName, status: 'completed' });
        return results;
    }

    private async analyzeSingleModule(
        runId: string,
        module: Module,
        language: string,
        index: number,
        total: number,
        allContent: string, // 新增参数
        tokenCount: number  // 新增参数
    ): Promise<ModuleDoc> {
    // --- highlight-end ---
        const { logger } = this.context;
        const taskId = uuidv4();
        const stepName = `分析模块: '${module.name}' (${index}/${total})`;
        logger.info(`[DEBUG] Attempting to start sub-step: ${stepName} with taskId: ${taskId}`);
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        const moduleAnalysisDir = vscode.Uri.joinPath(this.runDir, `module_${module.path.replace(/[\/\\]/g, '_')}`);
        await vscode.workspace.fs.createDirectory(moduleAnalysisDir);

        const moduleContext: AgentContext = { ...this.context, runDir: moduleAnalysisDir };

        // --- highlight-start ---
        // 移除内部的文件读取和Token计算，因为它们已经作为参数传入
        // const contentTool = this.context.toolRegistry.getTool('get_all_files_content') as any;
        // const allContent = await contentTool.call({ path: module.path, language }) as string;
        // const tokenCount = this.tokenizer.encode(allContent).length;
        // --- highlight-end ---

        let executor: ToolChainExecutor | MapReduceExecutor;
        let promptYaml: string;
        let strategy: string;

        let strategyLogContent = `模块路径: ${module.path}\n`;

        if (tokenCount <= this.maxTokensForDirectAnalysis) {
            strategy = "直接分析 (ToolChain)";
            executor = new ToolChainExecutor(moduleContext);
            promptYaml = this.prompts.directAnalysisPrompt;
            strategyLogContent += `Token总数: ${tokenCount.toLocaleString()} 未超出最大Token数 ${this.maxTokensForDirectAnalysis.toLocaleString()} 限制\n`;
            strategyLogContent += `采用全量分析策略，请稍后...`;
        } else {
            strategy = "Map-Reduce分析";
            executor = new MapReduceExecutor(moduleContext);
            const estimatedBatches = Math.ceil(tokenCount / this.maxTokensForDirectAnalysis);
            promptYaml = this.prompts.mapReduceAnalysisPrompt;
            strategyLogContent += `Token总数: ${tokenCount.toLocaleString()} 超出最大Token数 ${this.maxTokensForDirectAnalysis} 限制\n`;
            strategyLogContent += `采用Map-Reduce分析策略，预计分 ${estimatedBatches} 个批次，因涉及多个迭代，分析时间稍长，请稍后...`;
        }

        logger.onStepUpdate({
            runId,
            taskId,
            type: 'input',
            data: {
                name: "分析策略",
                content: strategyLogContent
            }
        });
        try {
            // 将完整的模块路径传递给执行器
            const result: ExecutorResult = await executor.run(runId, promptYaml, { module_path: module.path, language, task_description: module.description });
            const docContent = result.finalContent;
            const docPath = vscode.Uri.joinPath(this.runDir, `module_${module.name.replace(/[\s\/]/g, '_')}.md`);
            await vscode.workspace.fs.writeFile(docPath, Buffer.from(docContent, 'utf8'));

            if (result.intermediateFiles && result.intermediateFiles.length > 0) {
                for (const file of result.intermediateFiles) {
                    logger.onStepUpdate({
                        runId,
                        taskId,
                        type: 'output',
                        data: { name: file.name, content: `文件已生成: ${path.basename(file.path)}` },
                        metadata: { type: 'file', path: file.path }
                    });
                }
            }
            logger.onStepUpdate({
                runId,
                taskId,
                type: 'output',
                data: { name: "模块文档", content: `文档已生成: ${path.basename(docPath.fsPath)}` },
                metadata: { type: 'file', path: docPath.fsPath }
            });
            logger.onStepEnd({ runId, taskId, stepName, status: 'completed' });
            return { ...module, content: docContent };
        } catch (e: any) {

            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.onStepEnd({ runId, taskId, stepName, status: 'failed', error: errorMessage });

            throw e;
        }
    }

    /**
     * 清洗并重编号单个模块的Markdown文档。
     * @param rawContent 原始Markdown内容。
     * @param newParentSectionNumber 新的父章节号，如 "3.3"。
     * @returns 处理后的Markdown内容。
     */
    private cleanAndRenumberModuleDoc(rawContent: string, newParentSectionNumber: string): string {
        // 1. 清洗：只保留第一个'#'标题之后的内容
        const firstHeadingIndex = rawContent.indexOf('#');
        if (firstHeadingIndex === -1) {
            return ''; // 如果没有标题，则视为空内容
        }
        const content = rawContent.substring(firstHeadingIndex);
        const lines = content.split('\n');

        // 2. 提取原始主标题，并创建新的、重编号的主标题
        const originalTitleLine = lines.shift() || '';
        const title = originalTitleLine.replace(/^#\s*/, '').trim();
        const newMainHeading = `# ${newParentSectionNumber}. ${title}`;

        // 3. 重编号所有子标题
        const body = lines.join('\n');
        const renumberedBody = body.replace(
            /^(#+)\s(\d[\d\.]*)/gm, // 匹配所有级别的标题，如 '## 1. ...' 或 '### 1.2. ...'
            (match, hashes, oldNumbering) => {
                // 将标题降一级（增加一个'#'），并用新的父章节号作为前缀
                return `#${hashes} ${newParentSectionNumber}.${oldNumbering}`;
            }
        );

        return `${newMainHeading}\n${renumberedBody}`;
    }

    private async runSynthesisPhase(runId: string, plan: PlannerOutput, moduleDocs: ModuleDoc[]): Promise<string> {
        const { logger, llmService, modelConfig, statsTracker } = this.context;
        const taskId = uuidv4();
        const stepName = "综合: 生成最终文档";
        logger.onStepStart({ runId, taskId, stepName, status: 'running' });

        // --- 步骤 1: 生成文档框架 ---
        const synthesisLlm = await llmService.createModel({ modelConfig, temperature: 0.4, streaming: false });
        const synthesisPromptTemplate = (yaml.load(this.prompts.synthesisPrompt) as any).llm_prompt_template.human;
        const moduleOverviews = moduleDocs.map(m => `- **${m.name} (${m.path})**: ${m.description}`).join('\n');
        
        // 关键改动：不将详细文档传给LLM，让它只生成框架
        const prompt = synthesisPromptTemplate
            .replace('{projectName}', plan.projectName)
            .replace('{language}', plan.language)
            .replace('{module_overviews}', moduleOverviews)
            .replace('{detailed_module_docs}', '<!-- 模块详细设计将由程序自动拼接 -->');

        logger.onStepUpdate({ runId, taskId, type: 'llm-request', data: { system: "...", human: prompt }});
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_request.txt'),
            Buffer.from(prompt, 'utf8')
        );

        const chain = synthesisLlm.pipe(new StringOutputParser());
        const wrapperDoc = await chain.invoke([new HumanMessage(prompt)]);
        statsTracker.add(prompt, wrapperDoc);

         // 步骤 2: 准备拼接模块文档
        const processedModuleDocs = moduleDocs.map((doc, index) => {
            const parentSectionNumber = `3.${3 + index}`; // 生成 3.3, 3.4, ...
            return this.cleanAndRenumberModuleDoc(doc.content, parentSectionNumber);
        });
        const combinedModuleDocsString = processedModuleDocs.join('\n\n---\n\n');

        // 步骤 3: 找到插入点并拼接
        const splitMarker = '\n# 4. 接口设计';
        const splitIndex = wrapperDoc.indexOf(splitMarker);
        
        let finalDoc: string;

        if (splitIndex !== -1) {
            // 找到了插入点
            let docPart1 = wrapperDoc.substring(0, splitIndex);
            const docPart2 = wrapperDoc.substring(splitIndex);

            // 清理掉 part1 末尾可能存在的占位符
            docPart1 = docPart1.replace(/##\s*3\.3\s*模块详细设计[\s\S]*/, '').trim();

            finalDoc = [
                docPart1,
                combinedModuleDocsString,
                docPart2
            ].join('\n\n');
        } else {
            // 如果没找到第4节，作为回退，直接在末尾拼接
            logger.warn("在文档框架中未找到'# 4. 接口设计'，将模块文档追加到末尾。");
            finalDoc = [
                wrapperDoc,
                combinedModuleDocsString
            ].join('\n\n---\n\n');
        }
        
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(this.runDir, '03_synthesis_response.txt'),
            Buffer.from(finalDoc, 'utf8')
        );

        const finalDocPath = await this.getFinalDocPath();
        logger.onStepUpdate({ 
            runId, 
            taskId, 
            type: 'output', 
            data: { name: "最终项目文档", content: `文档已生成: ${path.basename(finalDocPath.fsPath)}` },
            metadata: { type: 'file', path: finalDocPath.fsPath }
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