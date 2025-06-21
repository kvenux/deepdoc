// src/extension/agents/executors/MapReduceExecutor.ts (修改后完整文件)

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { get_encoding, Tiktoken } from 'tiktoken';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentContext } from '../AgentContext';

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

    public async run(yamlContent: string, userInputs: Record<string, any>): Promise<string> {
        const { logger, llmService, modelConfig, runDir } = this.context;
        let tokenizer: Tiktoken | null = null;
        
        try {
            logger.info("[STEP 1/5] Parsing Map-Reduce YAML...");
            const actionPrompt = yaml.load(yamlContent) as MapReducePrompt;
            
            logger.info("\n[STEP 2/5] Gathering and tokenizing files...");
            const modulePath = userInputs['module_path'];
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) throw new Error("No workspace folder open.");
            const workspaceRoot = workspaceFolders[0].uri;
            const absoluteModulePath = vscode.Uri.joinPath(workspaceRoot, modulePath);
            const fileUris = await getAllFilePaths(absoluteModulePath);
            tokenizer = get_encoding("cl100k_base");
            
            // ================================================================
            // ==================== 错误修正处 ====================
            // ================================================================
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
            // ================================================================
            // ================================================================

            const allFiles = await Promise.all(fileDataPromises);
            logger.info(` -> Found ${allFiles.length} files in '${modulePath}'.`);

            logger.info("\n[STEP 3/5] Creating file batches...");
            const MAX_TOKENS_PER_BATCH = actionPrompt.max_tokens_per_batch || 12000;
            const batches: FileData[][] = [];
            let currentBatch: FileData[] = [];
            let currentBatchTokens = 0;
            for (const file of allFiles) {
                if (file.tokenCount > MAX_TOKENS_PER_BATCH) {
                    logger.warn(`[WARN] Skipping file '${file.path}' as its token count (${file.tokenCount}) exceeds the batch limit.`);
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
            logger.info(` -> Created ${batches.length} batches.`);


            logger.info("\n[STEP 4/5] Starting MAP phase...");
            const llm = await llmService.createModel({ modelConfig, temperature: 0.1, streaming: false });
            const mapAnalysisPromises = batches.map(async (batch, i) => {
                logger.info(` -> [MAP] Starting analysis for Batch ${i + 1}/${batches.length}...`);
                const batchContent = batch.map(file => `--- START OF FILE: ${file.path} ---\n${file.content}\n--- END OF FILE ---`).join('\n\n');
                const humanPrompt = actionPrompt.map_prompt_template.human.replace('{code_files_collection}', batchContent);
                const mapMessages = [new SystemMessage(actionPrompt.map_prompt_template.system), new HumanMessage(humanPrompt)];
                
                if (runDir) {
                    const requestPath = vscode.Uri.joinPath(runDir, `map_${i + 1}_request.txt`);
                    await vscode.workspace.fs.writeFile(requestPath, Buffer.from(humanPrompt, 'utf8'));
                }
                
                const response = await llmService.scheduleLlmCall(() => llm.invoke(mapMessages));
                const responseContent = response.content as string;
                
                if (runDir) {
                    const responsePath = vscode.Uri.joinPath(runDir, `map_${i + 1}_response.md`);
                    await vscode.workspace.fs.writeFile(responsePath, Buffer.from(responseContent, 'utf8'));
                }

                logger.info(` -> [MAP] Finished analysis for Batch ${i + 1}.`);
                return responseContent;
            });
            const mapResults = await Promise.all(mapAnalysisPromises);
            const combinedMarkdownSummaries = mapResults.join("\n\n");
            logger.info(" -> [MAP] All batches analyzed successfully.");

            logger.info("\n[STEP 5/5] Starting REDUCE phase...");
            const reduceLlm = await llmService.createModel({ modelConfig, temperature: 0.5, streaming: false });
            let humanReducePrompt = actionPrompt.reduce_prompt_template.human;
            for (const key in userInputs) {
                humanReducePrompt = humanReducePrompt.replace(new RegExp(`\\{${key}\\}`, 'g'), userInputs[key]);
            }
            humanReducePrompt = humanReducePrompt.replace('{combined_markdown_summaries}', combinedMarkdownSummaries);
            
            if (runDir) {
                const requestPath = vscode.Uri.joinPath(runDir, `llm_request.txt`);
                await vscode.workspace.fs.writeFile(requestPath, Buffer.from(humanReducePrompt, 'utf8'));
            }

            const reduceMessages = [new SystemMessage(actionPrompt.reduce_prompt_template.system), new HumanMessage(humanReducePrompt)];
            const finalResponse = await llmService.scheduleLlmCall(() => reduceLlm.invoke(reduceMessages));
            const finalContent = finalResponse.content as string;

            if (runDir) {
                const responsePath = vscode.Uri.joinPath(runDir, `llm_response.md`);
                await vscode.workspace.fs.writeFile(responsePath, Buffer.from(finalContent, 'utf8'));
            }

            return finalContent;

        } catch (error: any) {
            logger.error("Map-Reduce execution failed", error);
            throw error;
        } finally {
            if (tokenizer) {
                tokenizer.free();
            }
        }
    }
}