// src/extension/agents/ProjectDocumentationAgent.ts

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ModelConfig } from '../../common/types';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { get_encoding, Tiktoken } from 'tiktoken';
import { GetDirectoryTreeTool, GetAllFilesContentTool } from '../tools/fileSystemTools';
import { runMapReduceAgent } from '../agentOrchestrator';
import { runActionPrompt } from '../agentRunner';
import { createFileSelectorLLMTool } from '../tools/llmTools';
import { StructuredTool } from '@langchain/core/tools';
import { AgentExecutorCallbacks } from './CustomAgentExecutor';
import { LLMService } from '../LLMService'; // 导入 LLMService
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

// 定义规划阶段的输出结构
interface PlannerOutput {
    projectName: string;
    language: string; // e.g., 'typescript'
    modules: { name: string; path: string; description: string; }[];
}

// 用于加载和解析外部YAML文件的辅助函数
async function loadPromptFile(workspaceRoot: vscode.Uri, fileName: string): Promise<string> {
    const promptUri = vscode.Uri.joinPath(workspaceRoot, '.codewiki', fileName);
    try {
        const fileContent = await vscode.workspace.fs.readFile(promptUri);
        return Buffer.from(fileContent).toString('utf-8');
    } catch (e) {
        throw new Error(`无法加载提示词文件: ${fileName}。请确保它存在于 '.codewiki' 目录中。`);
    }
}

// 辅助函数：用于创建延迟
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class ProjectDocumentationAgent {
    private outputChannel: vscode.OutputChannel;
    private modelConfig: ModelConfig;
    private llmService: LLMService; // 使用 LLMService
    private tokenizer: Tiktoken;
    private readonly MAX_TOKENS_FOR_DIRECT_ANALYSIS = 32000;
    private tools: StructuredTool[] = [];

    constructor(outputChannel: vscode.OutputChannel, modelConfig: ModelConfig, llmService: LLMService) {
        this.outputChannel = outputChannel;
        this.modelConfig = modelConfig;
        this.llmService = llmService; // 存储 LLMService 实例
        this.tokenizer = get_encoding("cl100k_base");
    }

    private async initialize() {
        // 如果工具已初始化，则跳过
        if (this.tools.length > 0) return;

        // 异步创建用于工具的 LLM
        const toolLlm = await this.llmService.createModel({
            modelConfig: this.modelConfig,
            temperature: 0.1,
            streaming: false
        });
        
        this.tools = [
            new GetDirectoryTreeTool(),
            new GetAllFilesContentTool(),
            createFileSelectorLLMTool(toolLlm)
        ];
    }

    private log(message: string) {
        this.outputChannel.appendLine(message);
    }
    
    private async invokeLlmAndLog(
        messages: BaseMessage[], 
        logFileBaseName: string, 
        runDirUri: vscode.Uri,
        temperature: number = 0.1 // 允许指定温度
    ): Promise<string> {
        const requestContent = messages.map(m => `[${m._getType()}]\n${m.content}`).join('\n\n---\n\n');
        const requestPath = vscode.Uri.joinPath(runDirUri, `${logFileBaseName}_request.txt`);
        await vscode.workspace.fs.writeFile(requestPath, Buffer.from(requestContent, 'utf8'));

        // 使用 LLMService 创建一个具有特定配置的、非流式的 LLM
        const nonStreamingLlm = await this.llmService.createModel({
            modelConfig: this.modelConfig,
            streaming: false,
            temperature,
        });

        const response = await nonStreamingLlm.invoke(messages);
        const responseContent = response.content.toString();

        const responsePath = vscode.Uri.joinPath(runDirUri, `${logFileBaseName}_response.txt`);
        await vscode.workspace.fs.writeFile(responsePath, Buffer.from(responseContent, 'utf8'));
        
        return responseContent;
    }
    
    public async run() {
        this.log("--- [启动] 项目文档生成智能体 ---");
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error("请先打开一个工作区文件夹。");
        }
        
        // 在运行开始时进行异步初始化
        await this.initialize();

        const runId = `doc-gen_${this.modelConfig.modelId.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const runDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki', 'runs', runId);
        await vscode.workspace.fs.createDirectory(runDir);
        this.log(`[信息] 本次运行的结果将保存在: ${runDir.fsPath}`);

        try {
            this.log("\n--- [阶段 0/4] 加载外部提示词... ---");
            const plannerPromptContent = await loadPromptFile(workspaceRoot, 'project_planner.yml');
            const plannerPromptTemplate = (yaml.load(plannerPromptContent) as any).llm_prompt_template.human;
            this.log("[成功] 已加载规划器提示词。");

            this.log("\n--- [阶段 1/4] 规划: 分析项目结构... ---");
            const plan = await this.runPlanningPhase(workspaceRoot, runDir, plannerPromptTemplate);
            const planPath = vscode.Uri.joinPath(runDir, 'plan.json');
            await vscode.workspace.fs.writeFile(planPath, Buffer.from(JSON.stringify(plan, null, 2), 'utf8'));
            this.log(`[成功] 规划完成。规划文件已保存至 plan.json。`);

            this.log("\n--- [阶段 2/4] 执行: 并行分析独立模块 (带延迟)... ---");
            const moduleAnalysisPromises: Promise<{ name: string; path: string; content: string; }>[] = [];

            for (const [index, module] of plan.modules.entries()) {
                // 为每个模块创建一个异步分析任务
                const analyzeSingleModule = async (): Promise<{ name: string; path: string; content: string; }> => {
                    this.log(`\n[模块 ${index + 1}/${plan.modules.length}] 开始分析 '${module.name}' (路径: '${module.path}')...`);
                    const moduleDocContent = await this.analyzeModule(workspaceRoot, module, plan.language, runDir);
                    
                    const moduleDocPath = vscode.Uri.joinPath(runDir, `module_${module.name.replace(/[\s\/]/g, '_')}.md`);
                    await vscode.workspace.fs.writeFile(moduleDocPath, Buffer.from(moduleDocContent, 'utf8'));

                    this.log(`[成功] 模块 '${module.name}' 分析完成，文档已保存。`);
                    return { ...module, content: moduleDocContent };
                };

                // 启动任务并将其Promise添加到列表中
                moduleAnalysisPromises.push(analyzeSingleModule());

                // 如果不是最后一个模块，则等待1.5秒再启动下一个
                if (index < plan.modules.length - 1) {
                    this.log(`    (等待 1.5s 后启动下一个模块的分析...)`);
                    await sleep(1500);
                }
            }

            this.log(`\n[信息] 所有 ${plan.modules.length} 个模块的分析任务已启动，正在等待全部完成...`);
            const moduleDocs = await Promise.all(moduleAnalysisPromises);
            this.log(`\n[成功] 所有模块均已分析完毕。`);

            this.log("\n--- [阶段 3/4] 综合: 生成最终文档... ---");
            const synthesisPromptContent = await loadPromptFile(workspaceRoot, 'project_synthesis.yml');
            const synthesisPromptTemplate = (yaml.load(synthesisPromptContent) as any).llm_prompt_template.human;
            
            const finalDoc = await this.runSynthesisPhase(plan, moduleDocs, runDir, synthesisPromptTemplate);
            const finalDocPath = vscode.Uri.joinPath(runDir, '项目总体设计文档.md');
            await vscode.workspace.fs.writeFile(finalDocPath, Buffer.from(finalDoc, 'utf8'));
            
            this.log(`\n--- [完成] ---`);
            this.log(`项目文档已成功生成！`);
            vscode.window.showInformationMessage(`文档已保存至: ${finalDocPath.fsPath}`, '打开文件').then(selection => {
                if (selection === '打开文件') {
                    vscode.window.showTextDocument(finalDocPath);
                }
            });

        } catch (error: any) {
            const errorMessage = `[致命错误] 智能体执行失败: ${error.message}\n${error.stack}`;
            this.log(errorMessage);
            vscode.window.showErrorMessage(error.message);
        } finally {
             this.tokenizer.free();
        }
    }

    private async runPlanningPhase(workspaceRoot: vscode.Uri, runDir: vscode.Uri, promptTemplate: string): Promise<PlannerOutput> {
        const treeTool = new GetDirectoryTreeTool();
        this.log("[规划] 正在生成文件树...");
        const fileTree = await treeTool.call({ path: '.', language: 'unknown' });
        
        this.log("[规划] 正在调用大模型进行规划...");
        const prompt = promptTemplate.replace('{file_tree}', fileTree);
        const messages: BaseMessage[] = [new HumanMessage(prompt)];
        
        // 使用默认温度 (0.1)
        const responseContent = await this.invokeLlmAndLog(messages, "01_planning", runDir);
        
        try {
            const jsonString = responseContent.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonString) throw new Error("大模型未能返回有效的JSON规划。");
            return JSON.parse(jsonString) as PlannerOutput;
        } catch (e: any) {
            throw new Error(`解析规划输出失败: ${e.message}。原始输出: ${responseContent}`);
        }
    }

    private async analyzeModule(
        workspaceRoot: vscode.Uri,
        module: { name: string; path: string },
        language: string,
        runDir: vscode.Uri
    ): Promise<string> {
        const moduleRunDir = vscode.Uri.joinPath(runDir, `module_analysis_${module.path.replace(/[\/\\]/g, '_')}`);
        await vscode.workspace.fs.createDirectory(moduleRunDir);

        const contentTool = new GetAllFilesContentTool();
        const allContent = await contentTool.call({ path: module.path, language });
        const tokenCount = this.tokenizer.encode(allContent).length;
        this.log(` -> 模块 '${module.name}' Token总数: ${tokenCount}`);
        
        let finalResult = '';
        const callbacks: AgentExecutorCallbacks = {
            onToolStart: (toolName, input) => this.log(`   [TOOL START] ${toolName}: ${JSON.stringify(input)}`),
            onToolEnd: (toolName, output) => {
                const summary = output.length > 300 ? `${output.substring(0, 300)}...` : output;
                this.log(`   [TOOL END] ${toolName} -> (输出预览): ${summary}`);
            },
            onLlmStart: (system, human) => {
                this.log(`   [LLM START]`);
                const requestContent = `[SYSTEM]\n${system}\n\n---\n\n[HUMAN]\n${human}`;
                const requestPath = vscode.Uri.joinPath(moduleRunDir, `llm_request.txt`);
                vscode.workspace.fs.writeFile(requestPath, Buffer.from(requestContent, 'utf8'));
            },
            onLlmStream: (chunk) => { /* 不在主channel刷屏 */ },
            onLlmEnd: (result) => {
                this.log(`   [LLM END]`);
                const responsePath = vscode.Uri.joinPath(moduleRunDir, `llm_response.md`);
                vscode.workspace.fs.writeFile(responsePath, Buffer.from(result, 'utf8'));
            },
            onError: (error) => {
                this.log(`   [错误] 子流程执行失败: ${error.message}`);
                finalResult = `模块分析失败: ${error.message}`;
            }
        };

        if (tokenCount <= this.MAX_TOKENS_FOR_DIRECT_ANALYSIS) {
            this.log(` -> Token数在限制内，使用直接分析流程 (runActionPrompt)...`);
            const yamlContent = await loadPromptFile(workspaceRoot, 'module_analysis_direct.yml');
            finalResult = await runActionPrompt({
                yamlContent,
                userInputs: { module_path: module.path, language },
                modelConfig: this.modelConfig,
                tools: this.tools,
                callbacks,
                llmService: this.llmService // 传入 LLMService
            });
        } else {
            this.log(` -> Token数超出限制，使用Map-Reduce流程 (runMapReduceAgent)...`);
            const yamlContent = await loadPromptFile(workspaceRoot, 'module_analysis_mapreduce.yml');
            const mapReduceChannel: vscode.OutputChannel = {
                ...this.outputChannel,
                append: (value: string) => this.log(`   [MR] ${value}`),
                appendLine: (value: string) => this.log(`   [MR] ${value}`),
                clear: () => {},
                replace: (value: string) => this.log(`   [MR] ${value}`),
                name: "MapReduce-Proxy"
            };
            
            finalResult = await runMapReduceAgent(
                yamlContent, 
                { module_path: module.path, language }, 
                this.modelConfig, 
                mapReduceChannel,
                this.llmService // 传入 LLMService
            );
        }

        return finalResult;
    }

    private async runSynthesisPhase(plan: PlannerOutput, moduleDocs: { name: string; content: string; }[], runDir: vscode.Uri, promptTemplate: string): Promise<string> {
        const moduleOverviews = plan.modules.map(m => `- **${m.name} (${m.path})**: ${m.description}`).join('\n');
        const detailedModuleDocs = moduleDocs.map((doc, index) => `
### 3.3.${index + 1} ${doc.name} 模块详细设计
${doc.content}
`).join('\n---\n');

        const prompt = promptTemplate
            .replace('{projectName}', plan.projectName)
            .replace('{language}', plan.language)
            .replace('{module_overviews}', moduleOverviews)
            .replace('{detailed_module_docs}', detailedModuleDocs);

        this.log("[综合] 正在调用大模型生成最终文档...");
        const messages: BaseMessage[] = [new HumanMessage(prompt)];

        // 使用稍高的温度进行综合
        return await this.invokeLlmAndLog(messages, "03_synthesis", runDir, 0.4);
    }
}