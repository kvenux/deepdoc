// file_path: extension/agents/executors/MapReduceExecutor.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { v4 as uuidv4 } from 'uuid'; // 修正: 添加 import
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentContext } from '../AgentContext';
import { StringOutputParser } from '@langchain/core/output_parsers'; // 修正: 添加 import

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
    constructor(private readonly context: AgentContext) {}

    public async run(runId: string, yamlContent: string, userInputs: Record<string, any>): Promise<string> {
        const { logger, llmService, modelConfig, runDir } = this.context;
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
            logger.onStepUpdate({ runId, taskId: prepTaskId, type: 'output', data: { name: "文件列表", content: `找到 ${allFiles.length} 个文件。` } });

            const MAX_TOKENS_PER_BATCH = actionPrompt.max_tokens_per_batch || 12000;
            const batches: FileData[][] = [];
            let currentBatch: FileData[] = [];
            let currentBatchTokens = 0;
            for (const file of allFiles) {
                if (file.tokenCount > MAX_TOKENS_PER_BATCH) { continue; }
                if (currentBatchTokens + file.tokenCount > MAX_TOKENS_PER_BATCH) { batches.push(currentBatch); currentBatch = []; currentBatchTokens = 0; }
                currentBatch.push(file);
                currentBatchTokens += file.tokenCount;
            }
            if (currentBatch.length > 0) { batches.push(currentBatch); }
            logger.onStepUpdate({ runId, taskId: prepTaskId, type: 'output', data: { name: "批次信息", content: `创建了 ${batches.length} 个批次。` } });
            logger.onStepEnd({ runId, taskId: prepTaskId, stepName: prepStepName, status: 'completed' }); // 修正: 添加 stepName

            const mapStepName = "Map阶段: 并行分析";
            logger.onStepStart({ runId, stepName: mapStepName, status: 'running' }); // 这个是父步骤的开始

            const llm = await llmService.createModel({ modelConfig, temperature: 0.1, streaming: false });
            const mapAnalysisPromises = batches.map(async (batch, i) => {
                const mapTaskId = uuidv4(); 
                const mapTaskName = `分析批次 ${i + 1}/${batches.length}`;
                logger.onStepStart({ runId, taskId: mapTaskId, stepName: mapTaskName, status: 'running' });
                
                try {
                    const batchContent = batch.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join('\n\n');
                    const humanPrompt = actionPrompt.map_prompt_template.human.replace('{code_files_collection}', batchContent);
                    logger.onStepUpdate({ runId, taskId: mapTaskId, type: 'llm-request', data: { system: actionPrompt.map_prompt_template.system, human: humanPrompt } });
                    
                    const response = await llmService.scheduleLlmCall(() => llm.invoke([new SystemMessage(actionPrompt.map_prompt_template.system), new HumanMessage(humanPrompt)]));
                    const responseContent = response.content as string;

                    logger.onStepUpdate({ runId, taskId: mapTaskId, type: 'output', data: { name: "批次摘要", content: responseContent } });
                    logger.onStepEnd({ runId, taskId: mapTaskId, stepName: mapTaskName, status: 'completed' }); // 修正: 添加 stepName
                    return responseContent;
                } catch (e: any) {
                    logger.onStepEnd({ runId, taskId: mapTaskId, stepName: mapTaskName, status: 'failed', error: e.message }); // 修正: 添加 stepName
                    throw e;
                }
            });
            const mapResults = await Promise.all(mapAnalysisPromises);
            logger.onStepEnd({ runId, stepName: mapStepName, status: 'completed' }); // 修正: 父步骤的结束, 添加 stepName

            const reduceTaskId = uuidv4(); 
            const reduceStepName = "Reduce阶段: 综合摘要";
            logger.onStepStart({ runId, taskId: reduceTaskId, stepName: reduceStepName, status: 'running' });

            const combinedMarkdownSummaries = mapResults.join("\n\n");
            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'input', data: { name: "所有摘要", content: combinedMarkdownSummaries } });
            
            const reduceLlm = await llmService.createModel({ modelConfig, temperature: 0.5, streaming: true });
            let humanReducePrompt = actionPrompt.reduce_prompt_template.human;
            for (const key in userInputs) {
                humanReducePrompt = humanReducePrompt.replace(new RegExp(`\\{${key}\\}`, 'g'), userInputs[key]);
            }
            humanReducePrompt = humanReducePrompt.replace('{combined_markdown_summaries}', combinedMarkdownSummaries);
            
            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'llm-request', data: { system: actionPrompt.reduce_prompt_template.system, human: humanReducePrompt } });

            const reduceChain = reduceLlm.pipe(new StringOutputParser()); 
            const stream = await reduceChain.stream([ new SystemMessage(actionPrompt.reduce_prompt_template.system), new HumanMessage(humanReducePrompt) ]);

            let finalContent = '';
            for await (const chunk of stream) {
                const chunkContent = chunk as string; 
                finalContent += chunkContent;
                // logger.onStreamChunk({ runId, taskId: reduceTaskId, content: chunkContent });
            }

            logger.onStepUpdate({ runId, taskId: reduceTaskId, type: 'output', data: { name: "最终文档", content: finalContent }, metadata: { type: 'markdown' } });
            logger.onStepEnd({ runId, taskId: reduceTaskId, stepName: reduceStepName, status: 'completed' }); // 修正: 添加 stepName
            
            return finalContent;

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