// file_path: extension/agents/executors/MapReduceExecutor.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { v4 as uuidv4 } from 'uuid'; // 修正: 添加 import
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentContext } from '../AgentContext';
import { StringOutputParser } from '@langchain/core/output_parsers'; // 修正: 添加 import
import { ToolChainStep } from '../CustomAgentExecutor';

export interface ExecutorResult {
    finalContent: string;
    intermediateFiles?: { name: string; path: string }[];
}

// 为新的、更复杂的提示词结构定义接口
interface MapReducePrompt {
    title?: string;
    description?: string;
    input_variables: { name: string; description: string; type: string; default?: string }[];
    tool_chain?: ToolChainStep[]; // 新增：预处理工具链
    map_prompt_template: { system: string; human: string };
    reduce_prompt_template: { system: string; human: string };
    max_tokens_per_batch?: number;
}

// 定义文件数据结构，增加一个可选的 'type' 字段用于分类
interface FileData {
    path: string;
    content: string;
    tokenCount: number;
    type?: 'simple' | 'complex';
}

// 定义一个阈值，用于区分简单文件和复杂文件
const COMPLEX_FILE_LINE_THRESHOLD = 100; // 行数超过150行的文件被认为是复杂的

// 辅助函数
async function getAllFilePaths(dirUri: vscode.Uri): Promise<vscode.Uri[]> {
    let files: vscode.Uri[] = [];
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name, type] of entries) {
        const entryUri = vscode.Uri.joinPath(dirUri, name);
        if (type === vscode.FileType.File) {
            if (!name.startsWith('.') && !['node_modules', 'dist', 'out'].some(part => entryUri.path.includes(`/${part}/`))) {
                files.push(entryUri);
            }
        } else if (type === vscode.FileType.Directory) {
            if (!name.startsWith('.') && !['node_modules', 'dist', 'out'].includes(name)) {
                files = files.concat(await getAllFilePaths(entryUri));
            }
        }
    }
    return files;
}

export class MapReduceExecutor {
    constructor(private readonly context: AgentContext) { }

    public async run(runId: string, yamlContent: string, userInputs: Record<string, any>): Promise<ExecutorResult> {
        const { logger, llmService, toolRegistry, modelConfig, runDir, statsTracker, performanceConfig } = this.context;
        let tokenizer: Tiktoken | null = null;

        try {
            const prepTaskId = uuidv4();
            const prepStepName = "解析与准备";
            logger.onStepStart({ runId, taskId: prepTaskId, stepName: prepStepName, status: 'running' });

            const actionPrompt = yaml.load(yamlContent) as MapReducePrompt;
            const modulePath = userInputs['module_path'];
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) throw new Error("未打开工作区文件夹。");

            const workspaceRoot = workspaceFolders[0].uri;
            const absoluteModulePath = vscode.Uri.joinPath(workspaceRoot, modulePath);

            // 新增：执行预处理工具链
            const executionContext: Record<string, any> = { ...userInputs };
            if (actionPrompt.tool_chain) {
                const toolChainStepName = "预处理: 执行工具";
                const toolChainTaskId = uuidv4();
                logger.onStepStart({ runId, taskId: toolChainTaskId, stepName: toolChainStepName, status: 'running' });
                for (const step of actionPrompt.tool_chain) {
                    const tool = toolRegistry.getTool(step.tool);
                    if (!tool) throw new Error(`工具 "${step.tool}" 未找到。`);

                    const toolInput = this.resolveInput(step.input, executionContext);
                    logger.onStepUpdate({ runId, taskId: toolChainTaskId, type: 'input', data: { name: `工具输入: ${step.tool}`, content: toolInput } });
                    
                    const toolOutputString = await tool.call(toolInput) as string;
                    executionContext[step.output_variable] = toolOutputString;
                    
                    logger.onStepUpdate({ runId, taskId: toolChainTaskId, type: 'output', data: { name: `工具输出: ${step.tool}`, content: toolOutputString } });
                }
                logger.onStepEnd({ runId, taskId: toolChainTaskId, stepName: toolChainStepName, status: 'completed' });
            }

            const fileUris = await getAllFilePaths(absoluteModulePath);
            tokenizer = get_encoding("cl100k_base");

            const fileDataPromises = fileUris.map(async (uri): Promise<FileData> => {
                if (!tokenizer) throw new Error("Tokenizer not initialized.");
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(contentBytes).toString('utf-8');
                return { path: path.relative(workspaceRoot.fsPath, uri.fsPath).replace(/\\/g, '/'), content, tokenCount: tokenizer.encode(content).length };
            });
            const allFiles = await Promise.all(fileDataPromises);
            const totalTokensInModule = allFiles.reduce((sum, file) => sum + file.tokenCount, 0);

            const simpleFileCount = allFiles.filter(f => f.type === 'simple').length;
            const complexFileCount = allFiles.filter(f => f.type === 'complex').length;
            logger.onStepUpdate({ runId, taskId: prepTaskId, type: 'output', data: { name: "文件分类统计", content: `共 ${allFiles.length} 个文件。简单型: ${simpleFileCount}, 复杂型: ${complexFileCount} (阈值: ${COMPLEX_FILE_LINE_THRESHOLD} 行)` } });

            const MAX_TOKENS_PER_BATCH = actionPrompt.max_tokens_per_batch || performanceConfig.maxTokensPerBatch;
            const batches: { files: FileData[], tokenCount: number }[] = [];
            let currentBatch: FileData[] = [];
            let currentBatchTokens = 0;
            for (const file of allFiles) {
                if (file.tokenCount > MAX_TOKENS_PER_BATCH) { continue; }
                if (currentBatchTokens + file.tokenCount > MAX_TOKENS_PER_BATCH) {
                    batches.push({ files: currentBatch, tokenCount: currentBatchTokens });
                    currentBatch = [];
                    currentBatchTokens = 0;
                }
                currentBatch.push(file);
                currentBatchTokens += file.tokenCount;
            }
            if (currentBatch.length > 0) {
                batches.push({ files: currentBatch, tokenCount: currentBatchTokens });
            }
            logger.onStepUpdate({ runId, taskId: prepTaskId, type: 'output', data: { name: "文件清单Token分析", content: `当前模块包含 ${allFiles.length} 个文件 ${totalTokensInModule} 个token，超过阈值 ${MAX_TOKENS_PER_BATCH}，创建 ${batches.length} 个批次迭代分析` } });
            logger.onStepEnd({ runId, taskId: prepTaskId, stepName: prepStepName, status: 'completed' }); // 修正: 添加 stepName

            const mapAllTaskId = uuidv4();
            const mapStepName = "Map阶段: 并行分析";
            logger.onStepStart({ runId, taskId: mapAllTaskId, stepName: mapStepName, status: 'running' });


            const llm = await llmService.createModel({ modelConfig, temperature: 0.1, streaming: true });
            const mapAnalysisPromises = batches.map(async (batchInfo, i) => {
                const mapTaskName = `分析批次 ${i + 1}/${batches.length}`;
                // 现在可以访问每个批次的token数，并在日志中显示
                logger.onStepUpdate({ runId, taskId: mapAllTaskId, type: 'input', data: { name: `${mapTaskName} `, content: `包含 ${batchInfo.files.length} 个文件，共 ${batchInfo.tokenCount} tokens.` } });

                try {
                    // 在批次内再次分类，并为新的提示模板准备内容
                    const batchSimpleFiles = batchInfo.files.filter(f => f.type === 'simple');
                    const batchComplexFiles = batchInfo.files.filter(f => f.type === 'complex');

                    const simpleCollectionContent = batchSimpleFiles.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join('\n\n');
                    const complexCollectionContent = batchComplexFiles.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join('\n\n');

                    let humanPrompt = actionPrompt.map_prompt_template.human
                        .replace('{simple_files_collection}', simpleCollectionContent || '无')
                        .replace('{complex_files_collection}', complexCollectionContent || '无');
                    
                    const systemPrompt = actionPrompt.map_prompt_template.system;
                    
                    const responseContent = await llmService.scheduleLlmCall(async () => {
                        const stream = await llm.stream([new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)]);
                        let fullReply = '';
                        for await (const chunk of stream) {
                            fullReply += chunk.content;
                        }
                        return fullReply;
                    });

                    // 在 Map 阶段的 LLM 调用后记录 Token
                    const fullMapPrompt = actionPrompt.map_prompt_template.system + "\n" + humanPrompt; // 估算，或者从 Langchain 内部获取更准确的
                    statsTracker.add(fullMapPrompt, responseContent);

                    logger.onStepUpdate({ runId, taskId: mapAllTaskId, type: 'output', data: { name: `${mapTaskName} 摘要结果`, content: responseContent } });
                    return responseContent;
                } catch (e: any) {
                    throw e;
                }
            });
            const mapResults = await Promise.all(mapAnalysisPromises);
            logger.onStepEnd({ runId, taskId: mapAllTaskId, stepName: mapStepName, status: 'completed' });

            const reduceTaskId = uuidv4();
            const reduceStepName = "Reduce阶段: 综合摘要";
            logger.onStepStart({ runId, taskId: reduceTaskId, stepName: reduceStepName, status: 'running' });

            const combinedMarkdownSummaries = mapResults.join("\n\n");

            const intermediateFiles: { name: string; path: string }[] = [];

            // 检查 runDir 是否存在。如果存在，说明是由 Orchestrator 调用的，需要保存中间文件。
            if (runDir) {
                const summaryFileName = 'map_phase_combined_summary.md';
                const summaryFilePath = vscode.Uri.joinPath(runDir, summaryFileName);
                await vscode.workspace.fs.writeFile(summaryFilePath, Buffer.from(combinedMarkdownSummaries, 'utf8'));

                // 将文件信息存入数组
                intermediateFiles.push({ name: 'Map阶段综合摘要', path: summaryFilePath.fsPath });
            }

            logger.onStepUpdate({
                runId,
                taskId: reduceTaskId,
                type: 'input',
                data: {
                    name: "Reduce阶段输入",
                    content: `摘要已合并 (长度: ${combinedMarkdownSummaries.length.toLocaleString()})，准备进行最终综合。`
                }
            });

            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'input', data: { name: "所有摘要", content: combinedMarkdownSummaries } });

            const reduceLlm = await llmService.createModel({ modelConfig, temperature: 0.5, streaming: true });
            // 更新 Reduce 阶段的提示填充逻辑，以包含所有需要的变量
            let humanReducePrompt = actionPrompt.reduce_prompt_template.human;
            for (const key in executionContext) {
                humanReducePrompt = humanReducePrompt.replace(new RegExp(`\\{${key}\\}`, 'g'), String(executionContext[key]));
            }
            humanReducePrompt = humanReducePrompt.replace('{combined_markdown_summaries}', combinedMarkdownSummaries);
            
            const systemReducePrompt = actionPrompt.reduce_prompt_template.system;
            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'llm-request', data: { system: systemReducePrompt, human: humanReducePrompt } });

            const reduceChain = reduceLlm.pipe(new StringOutputParser());
            const finalContent = await llmService.scheduleLlmCall(async () => {
                const stream = await reduceChain.stream([new SystemMessage(systemReducePrompt), new HumanMessage(humanReducePrompt)]);
                let fullReply = '';
                for await (const chunk of stream) {
                    fullReply += chunk;
                }
                return fullReply;
            });

            const fullReducePrompt = actionPrompt.reduce_prompt_template.system + "\n" + humanReducePrompt; // 估算
            statsTracker.add(fullReducePrompt, finalContent);

            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'output', data: { name: "最终文档", content: finalContent }, metadata: { type: 'markdown' } });
            logger.onStepEnd({ runId, taskId: reduceTaskId, stepName: reduceStepName, status: 'completed' }); // 修正: 添加 stepName

            return {
                finalContent,
                intermediateFiles
            };

        } catch (error: any) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw err;
        } finally {
            if (tokenizer) {
                tokenizer.free();
            }
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
}