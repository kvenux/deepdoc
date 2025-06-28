// file_path: extension/agents/executors/MapReduceExecutor.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { v4 as uuidv4 } from 'uuid'; // 修正: 添加 import
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentContext } from '../AgentContext';
import { StringOutputParser } from '@langchain/core/output_parsers'; // 修正: 添加 import

// 定义执行器的统一返回类型
export interface ExecutorResult {
    finalContent: string;
    intermediateFiles?: { name: string; path: string }[];
}

// 接口定义
interface MapReducePrompt {
    title?: string;
    description?: string;
    input_variables: { name: string; description: string; type: string; default?: string }[];
    map_prompt_template: { system: string; human: string };
    reduce_prompt_template: { system: string; human: string };
    max_tokens_per_batch?: number;
}

interface FileData {
    path: string;
    content: string;
    tokenCount: number;
}

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
        const { logger, llmService, modelConfig, runDir, statsTracker } = this.context; // <-- 获取 statsTracker
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

            const MAX_TOKENS_PER_BATCH = actionPrompt.max_tokens_per_batch || 12000;
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


            const llm = await llmService.createModel({ modelConfig, temperature: 0.1, streaming: false });
            const mapAnalysisPromises = batches.map(async (batchInfo, i) => {
                const mapTaskName = `分析批次 ${i + 1}/${batches.length}`;
                // 现在可以访问每个批次的token数，并在日志中显示
                logger.onStepUpdate({ runId, taskId: mapAllTaskId, type: 'input', data: { name: `${mapTaskName} `, content: `包含 ${batchInfo.files.length} 个文件，共 ${batchInfo.tokenCount} tokens.` } });

                try {
                    const batchContent = batchInfo.files.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join('\n\n');
                    const humanPrompt = actionPrompt.map_prompt_template.human.replace('{code_files_collection}', batchContent);
                    // logger.onStepUpdate({ runId, taskId: mapTaskId, type: 'llm-request', data: { system: actionPrompt.map_prompt_template.system, human: humanPrompt } });

                    const response = await llmService.scheduleLlmCall(() => llm.invoke([new SystemMessage(actionPrompt.map_prompt_template.system), new HumanMessage(humanPrompt)]));
                    const responseContent = response.content as string;

                    // 在 Map 阶段的 LLM 调用后记录 Token
                    const fullMapPrompt = actionPrompt.map_prompt_template.system + "\n" + humanPrompt; // 估算，或者从 Langchain 内部获取更准确的
                    statsTracker.add(fullMapPrompt, responseContent);

                    logger.onStepUpdate({ runId, taskId: mapAllTaskId, type: 'output', data: { name: `${mapTaskName} 摘要结果`, content: responseContent } });
                    // logger.onStepEnd({ runId, taskId: mapTaskId, stepName: mapTaskName, status: 'completed' }); // 修正: 添加 stepName
                    return responseContent;
                } catch (e: any) {
                    // logger.onStepEnd({ runId, taskId: mapTaskId, stepName: mapTaskName, status: 'failed', error: e.message }); // 修正: 添加 stepName
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

            const reduceLlm = await llmService.createModel({ modelConfig, temperature: 0.5, streaming: false });
            let humanReducePrompt = actionPrompt.reduce_prompt_template.human;
            for (const key in userInputs) {
                humanReducePrompt = humanReducePrompt.replace(new RegExp(`\\{${key}\\}`, 'g'), userInputs[key]);
            }
            humanReducePrompt = humanReducePrompt.replace('{combined_markdown_summaries}', combinedMarkdownSummaries);

            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'llm-request', data: { system: actionPrompt.reduce_prompt_template.system, human: humanReducePrompt } });

            const reduceChain = reduceLlm.pipe(new StringOutputParser());
            const finalContent = await llmService.scheduleLlmCall(() =>
                reduceChain.invoke([new SystemMessage(actionPrompt.reduce_prompt_template.system), new HumanMessage(humanReducePrompt)])
            );

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
}