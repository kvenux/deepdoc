// src/extension/agentOrchestrator.ts

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ModelConfig } from '../common/types';

// 定义我们新的YAML格式
interface MapReducePrompt {
    title?: string;
    description?: string;
    input_variables: { name: string; description: string; type: string; default?: string }[];
    map_prompt_template: { system: string; human: string };
    reduce_prompt_template: { system: string; human: string };
    max_tokens_per_batch?: number;
}

// 定义一个临时数据结构来处理文件
interface FileData {
    path: string;
    content: string;
    tokenCount: number;
}

// 递归获取所有文件路径的辅助函数
async function getAllFilePaths(dirUri: vscode.Uri): Promise<vscode.Uri[]> {
    let files: vscode.Uri[] = [];
    const entries = await vscode.workspace.fs.readDirectory(dirUri);

    for (const [name, type] of entries) {
        const entryUri = vscode.Uri.joinPath(dirUri, name);
        if (type === vscode.FileType.File) {
            // 简单过滤，可以根据需要扩展
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

// 核心执行函数
export async function runMapReduceAgent(
    yamlContent: string,
    userInputs: Record<string, string>,
    modelConfig: ModelConfig,
    outputChannel: vscode.OutputChannel
) {
    let tokenizer: Tiktoken | null = null;
    try {
        // 1. 解析和验证 YAML
        outputChannel.appendLine("[STEP 1/6] Parsing Action Prompt YAML...");
        const actionPrompt = yaml.load(yamlContent) as MapReducePrompt;
        if (!actionPrompt.map_prompt_template || !actionPrompt.reduce_prompt_template) {
            throw new Error("Invalid Map-Reduce YAML. Missing 'map_prompt_template' or 'reduce_prompt_template'.");
        }

        // 2. 收集和处理文件
        outputChannel.appendLine("\n[STEP 2/6] Gathering and tokenizing files...");
        const modulePath = userInputs['module_path'];
        if (!modulePath) {
            throw new Error("Missing required input 'module_path'.");
        }
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) throw new Error("No workspace folder open.");
        const workspaceRoot = workspaceFolders[0].uri;
        const absoluteModulePath = vscode.Uri.joinPath(workspaceRoot, modulePath);

        const fileUris = await getAllFilePaths(absoluteModulePath);
        tokenizer = get_encoding("cl100k_base"); // gpt-4, gpt-3.5
        
        const fileDataPromises = fileUris.map(async (uri): Promise<FileData> => {
            if (!tokenizer) {
                throw new Error("Tokenizer was not initialized correctly.");
            }
            const contentBytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(contentBytes).toString('utf-8');
            return {
                path: path.relative(workspaceRoot.fsPath, uri.fsPath).replace(/\\/g, '/'),
                content,
                tokenCount: tokenizer.encode(content).length,
            };
        });

        const allFiles = await Promise.all(fileDataPromises);
        outputChannel.appendLine(` -> Found ${allFiles.length} files in '${modulePath}'.`);

        // 3. 文件批处理
        outputChannel.appendLine("\n[STEP 3/6] Creating file batches based on token limit...");
        const MAX_TOKENS_PER_BATCH = actionPrompt.max_tokens_per_batch || 12000;
        const batches: FileData[][] = [];
        let currentBatch: FileData[] = [];
        let currentBatchTokens = 0;

        for (const file of allFiles) {
            if (file.tokenCount > MAX_TOKENS_PER_BATCH) {
                outputChannel.appendLine(`[WARN] Skipping file '${file.path}' as its token count (${file.tokenCount}) exceeds the batch limit.`);
                continue;
            }
            if (currentBatchTokens + file.tokenCount > MAX_TOKENS_PER_BATCH) {
                batches.push(currentBatch);
                currentBatch = [];
                currentBatchTokens = 0;
            }
            currentBatch.push(file);
            currentBatchTokens += file.tokenCount;
        }
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }
        outputChannel.appendLine(` -> Created ${batches.length} batches.`);

        // 4. MAP 阶段：循环处理每个批次
        outputChannel.appendLine("\n[STEP 4/6] Starting MAP phase: Analyzing batches...");
        const llm = new ChatOpenAI({
            modelName: modelConfig.modelId,
            apiKey: modelConfig.apiKey,
            configuration: { baseURL: modelConfig.baseUrl },
            temperature: 0.1, // 分析阶段需要确定性
        });

        let combinedMarkdownSummaries = "";
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            outputChannel.appendLine(` -> [MAP] Processing Batch ${i + 1} of ${batches.length} (${batch.length} files)...`);

            const batchContent = batch
                .map(file => `--- START OF FILE: ${file.path} ---\n${file.content}\n--- END OF FILE ---`)
                .join('\n\n');
            
            const humanPrompt = actionPrompt.map_prompt_template.human.replace('{code_files_collection}', batchContent);
            const mapMessages = [
                new SystemMessage(actionPrompt.map_prompt_template.system),
                new HumanMessage(humanPrompt),
            ];

            const response = await llm.invoke(mapMessages);
            combinedMarkdownSummaries += response.content + "\n\n";
        }
        outputChannel.appendLine(" -> [MAP] All batches analyzed successfully.");


        // 5. REDUCE 阶段：合成最终文档
        outputChannel.appendLine("\n[STEP 5/6] Starting REDUCE phase: Synthesizing final document...");
        
        // 注入变量到 Template
        let humanReducePrompt = actionPrompt.reduce_prompt_template.human;
        for (const key in userInputs) {
             humanReducePrompt = humanReducePrompt.replace(new RegExp(`\\{${key}\\}`, 'g'), userInputs[key]);
        }
        humanReducePrompt = humanReducePrompt.replace('{combined_markdown_summaries}', combinedMarkdownSummaries);
        
        const reduceMessages = [
            new SystemMessage(actionPrompt.reduce_prompt_template.system),
            new HumanMessage(humanReducePrompt),
        ];

        const reduceLlm = new ChatOpenAI({ ...llm.lc_kwargs, temperature: 0.5, streaming: true });
        const stream = await reduceLlm.stream(reduceMessages);

        outputChannel.appendLine("\n--- [FINAL DOCUMENT] ---");
        let fullResponse = "";
        for await (const chunk of stream) {
            const content = chunk.content as string;
            outputChannel.append(content);
            fullResponse += content;
        }
        outputChannel.appendLine("\n--- [END OF DOCUMENT] ---");

        // 6. 保存结果
        outputChannel.appendLine("\n[STEP 6/6] Saving result to output file...");
        const outputDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki', 'output');
        await vscode.workspace.fs.createDirectory(outputDir);
        
        const promptTitle = actionPrompt.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'map_reduce_agent';
        const outputFileName = `${promptTitle}-result-${Date.now()}.md`;
        const outputFilePath = vscode.Uri.joinPath(outputDir, outputFileName);

        await vscode.workspace.fs.writeFile(outputFilePath, Buffer.from(fullResponse, 'utf8'));
        outputChannel.appendLine(`\n[SUCCESS] Agent run finished. Result saved to: ${outputFilePath.fsPath}`);
        vscode.window.showInformationMessage(`Agent run successful. Output saved to .codewiki/output/`);

    } catch (error: any) {
        const finalError = `[FATAL] Agent execution failed: ${error.message}\n${error.stack}`;
        outputChannel.appendLine(`\n--- [ERROR] ---\n${finalError}`);
        vscode.window.showErrorMessage(error.message);
    } finally {
        tokenizer?.free(); // 释放 wasm 内存
    }
}