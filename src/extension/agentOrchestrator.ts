// src/extension/agentOrchestrator.ts

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ModelConfig } from '../common/types';

// highlight-start
// ================= Gemini 支持模块 =================
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * 标志位：设置为 true 以使用 Gemini，设置为 false 则使用 settings.json 中的模型配置。
 * 使用 Gemini 前，请确保已安装 `@langchain/google-genai` 并在 `.codewiki/.env` 文件中配置了 GOOGLE_API_KEY。
 */
const USE_GEMINI = false;

/**
 * 从工作区的 .codewiki/.env 文件中安全地读取 Google API 密钥。
 * @returns {Promise<string | undefined>} 返回 API 密钥或 undefined。
 */
async function getGoogleApiKey(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        // 没有打开的工作区，无法查找文件
        return undefined;
    }
    const workspaceRoot = workspaceFolders[0].uri;
    const envPath = vscode.Uri.joinPath(workspaceRoot, '.codewiki', '.env');

    try {
        const contentBytes = await vscode.workspace.fs.readFile(envPath);
        const content = Buffer.from(contentBytes).toString('utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim();
            // 简单解析，找到以 GOOGLE_API_KEY= 开头的行
            if (trimmedLine.startsWith('GOOGLE_API_KEY=')) {
                return trimmedLine.substring('GOOGLE_API_KEY='.length).trim();
            }
        }
    } catch (error) {
        // 如果文件不存在，这是正常情况，直接返回 undefined。
        // 如果是其他读取错误，可以在控制台打印日志。
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            console.error("Error reading .codewiki/.env file:", error);
        }
    }
    return undefined;
}
// ================================================
// highlight-end


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
): Promise<string> {
    return new Promise(async (resolve, reject) => {
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

            // highlight-start
            // ================= LLM 初始化（支持 Gemini） =================
            let llm: BaseChatModel;
            let reduceLlm: BaseChatModel;

            if (USE_GEMINI) {
                outputChannel.appendLine("[INFO] Using Google Gemini for execution.");
                const apiKey = await getGoogleApiKey();
                if (!apiKey) {
                    throw new Error("Gemini execution failed: 'GOOGLE_API_KEY' not found in your .codewiki/.env file.");
                }

                // 用于 Map 阶段的 LLM，需要确定性
                llm = new ChatGoogleGenerativeAI({
                    model: "gemini-2.5-flash", // 或其他兼容模型如 'gemini-1.5-flash'
                    apiKey: apiKey,
                    temperature: 0.1,
                });

                // 用于 Reduce 阶段的 LLM，可以更有创造性
                reduceLlm = new ChatGoogleGenerativeAI({
                    model: "gemini-2.5-flash",
                    apiKey: apiKey,
                    temperature: 0.5,
                });

            } else {
                outputChannel.appendLine(`[INFO] Using configured model '${modelConfig.name}' for execution.`);
                // 保持原有的 ChatOpenAI 逻辑
                let finalBaseUrl = '';
                const url = new URL(modelConfig.baseUrl);
                if (!url.pathname.includes('/v1')) {
                    url.pathname = ('/v1' + url.pathname).replace(/\/+/g, '/');
                }
                finalBaseUrl = url.toString().replace(/\/$/, '');

                llm = new ChatOpenAI({
                    modelName: modelConfig.modelId,
                    apiKey: modelConfig.apiKey,
                    streaming: false,
                    configuration: { baseURL: finalBaseUrl },
                    temperature: 0.1,
                });

                reduceLlm = new ChatOpenAI({
                    modelName: modelConfig.modelId,
                    apiKey: modelConfig.apiKey,
                    streaming: false,
                    configuration: { baseURL: finalBaseUrl },
                    temperature: 0.5,
                });
            }
            // =============================================================
            // highlight-end

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

            outputChannel.appendLine("\n--- [FINAL DOCUMENT] ---");
            outputChannel.appendLine("\n--- NOT Steamming ---");

            const finalResponse = await reduceLlm.invoke(reduceMessages);
            const fullResponse = finalResponse.content as string;

            outputChannel.appendLine("\n--- [END OF DOCUMENT] ---");

            // 6. 保存结果
            outputChannel.appendLine("\n[STEP 6/6] Saving result to output file...");
            const outputDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki', 'output');
            await vscode.workspace.fs.createDirectory(outputDir);

            const promptTitle = actionPrompt.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'map_reduce_agent';
            const outputFileName = `${promptTitle}-result-${Date.now()}.md`;
            const outputFilePath = vscode.Uri.joinPath(outputDir, outputFileName);

            let res = combinedMarkdownSummaries;
            res += "=================================="
            res += fullResponse
            await vscode.workspace.fs.writeFile(outputFilePath, Buffer.from(res, 'utf8'));
            outputChannel.appendLine(`\n[SUCCESS] Agent run finished. Result saved to: ${outputFilePath.fsPath}`);
            vscode.window.showInformationMessage(`Agent run successful. Output saved to .codewiki/output/`);
            resolve(fullResponse);

        } catch (error: any) {
            const finalError = `[FATAL] Agent execution failed: ${error.message}\n${error.stack}`;
            outputChannel.appendLine(`\n--- [ERROR] ---\n${finalError}`);
            vscode.window.showErrorMessage(error.message);
        } finally {
            tokenizer?.free(); // 释放 wasm 内存
        }
    });
}