// src/extension/extension.ts (完整文件)

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { CodeWikiViewProvider } from './CodeWikiViewProvider';
import { StateManager } from './StateManager';
import { runActionPrompt } from './agentRunner';
import { GetFileSummariesTool, GetFilesContentByListTool, GetAllFilesContentTool, GetDirectoryTreeTool } from './tools/fileSystemTools';
import { createFileSelectorLLMTool } from './tools/llmTools';
import { ChatOpenAI } from '@langchain/openai';
import { StructuredTool } from '@langchain/core/tools';
import { AgentExecutorCallbacks } from './agents/CustomAgentExecutor';

export function activate(context: vscode.ExtensionContext) {
    const provider = new CodeWikiViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeWikiViewProvider.viewType, provider)
    );

    // =========================================================================
    // == 重构：注册一个灵活的、可交互的 Agent 运行命令
    // =========================================================================
    const disposable = vscode.commands.registerCommand('codewiki.runAgent', async () => {
        const outputChannel = vscode.window.createOutputChannel("CodeWiki Agent Run");
        outputChannel.show(true);
        outputChannel.clear();
        outputChannel.appendLine("--- [START] CodeWiki Agent Runner ---\n");

        try {
            // 1. 获取工作区和 .codewiki 目录
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error("No workspace folder is open. Please open a project to run an agent.");
            }
            const workspaceRoot = workspaceFolders[0].uri;
            const codewikiDir = vscode.Uri.joinPath(workspaceRoot, '.codewiki');

            // 2. 扫描 .codewiki 目录下的所有 .yml 或 .yaml 文件
            let promptFiles: [string, vscode.FileType][] = [];
            try {
                promptFiles = await vscode.workspace.fs.readDirectory(codewikiDir);
            } catch (e) {
                throw new Error("The '.codewiki' directory was not found in your workspace root. Please create it and add your Action Prompt YAML files there.");
            }

            const ymlFiles = promptFiles
                .filter(([name, type]) => type === vscode.FileType.File && (name.endsWith('.yml') || name.endsWith('.yaml')))
                .map(([name, type]) => name);

            if (ymlFiles.length === 0) {
                throw new Error("No YAML (.yml, .yaml) prompt files found in the '.codewiki' directory.");
            }

            // 3. 使用 Quick Pick 让用户选择一个 Prompt
            const selectedFileName = await vscode.window.showQuickPick(ymlFiles, {
                placeHolder: 'Select an Action Prompt to run',
                title: 'CodeWiki Agent Runner'
            });

            if (!selectedFileName) {
                outputChannel.appendLine("[INFO] User cancelled the operation. Exiting.");
                return; // 用户取消选择
            }
            outputChannel.appendLine(`[STEP 1] User selected prompt: ${selectedFileName}`);

            // 4. 读取并解析选中的 YAML 文件
            const promptUri = vscode.Uri.joinPath(codewikiDir, selectedFileName);
            const fileContent = await vscode.workspace.fs.readFile(promptUri);
            const yamlContent = Buffer.from(fileContent).toString('utf-8');
            const actionPrompt = yaml.load(yamlContent) as {
                title?: string;
                description?: string;
                input_variables?: { name: string; description: string; type: string; default?: string }[];
            };
            outputChannel.appendLine(`[STEP 2] Successfully loaded and parsed: ${actionPrompt.title || selectedFileName}`);
            
            // 5. 动态获取用户输入
            const userInputs: Record<string, string> = {};
            if (actionPrompt.input_variables && Array.isArray(actionPrompt.input_variables)) {
                outputChannel.appendLine(`[STEP 3] Requesting user inputs...`);
                for (const variable of actionPrompt.input_variables) {
                    const value = await vscode.window.showInputBox({
                        prompt: `Enter value for '${variable.name}'`,
                        placeHolder: variable.description,
                        value: variable.default || '',
                        title: `Input for: ${actionPrompt.title || selectedFileName}`
                    });

                    if (value === undefined) {
                        outputChannel.appendLine("[INFO] User cancelled input. Exiting.");
                        return; // 用户取消输入
                    }
                    userInputs[variable.name] = value;
                    outputChannel.appendLine(`  - Input '${variable.name}': ${value}`);
                }
            } else {
                outputChannel.appendLine(`[STEP 3] No 'input_variables' defined in the prompt. Proceeding without user input.`);
            }

            outputChannel.appendLine(`\n--- Starting Agent Execution ---`);
            
            // 6. 获取模型配置和工具 (与之前逻辑相同)
            const stateManager = new StateManager(context.globalState);
            const modelConfigs = await stateManager.getModelConfigs();
            const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];
            if (!defaultConfig) { throw new Error("No default model config found."); }
            
            const url = new URL(defaultConfig.baseUrl);
            if (!url.pathname.includes('/v1')) { url.pathname = ('/v1' + url.pathname).replace(/\/+/g, '/'); }
            const finalBaseUrl = url.toString().replace(/\/$/, '');
            const toolLlm = new ChatOpenAI({ modelName: defaultConfig.modelId, apiKey: defaultConfig.apiKey, configuration: { baseURL: finalBaseUrl }, temperature: 0.1 });
            const tools: StructuredTool[] = [
                new GetFileSummariesTool(), 
                new GetFilesContentByListTool(), 
                new GetAllFilesContentTool(), 
                new GetDirectoryTreeTool(),
                createFileSelectorLLMTool(toolLlm)
            ];

            // 7. 定义回调并执行 Agent (与之前逻辑相同)
            let fullResponse = '';
            // highlight-start
            const callbacks: AgentExecutorCallbacks = {
                onToolStart: (toolName, input) => { outputChannel.appendLine(`\n--- [TOOL START] ---\nTool: ${toolName}\nInput: ${JSON.stringify(input, null, 2)}`); },
                onToolEnd: (toolName, output) => { const summary = output.length > 500 ? `${output.substring(0, 500)}... (truncated)` : output; outputChannel.appendLine(`Output: ${summary}\n--- [TOOL END] ---\n`); },
                
                // 修改 onLlmStart 的实现以接收并打印 prompt
                onLlmStart: (finalSystemPrompt, finalHumanPrompt) => {
                    outputChannel.appendLine(`--- [LLM PROMPT] ---`);
                    outputChannel.appendLine(`SYSTEM: ${finalSystemPrompt}`);
                    
                    const humanSummary = finalHumanPrompt.length > 1500 ? `${finalHumanPrompt.substring(0, 1500)}... (truncated)` : finalHumanPrompt;
                    outputChannel.appendLine(`\nHUMAN (truncated): ${humanSummary}`);
                    outputChannel.appendLine(`--- [END LLM PROMPT] ---\n`);
                    
                    outputChannel.appendLine(`--- [LLM START] ---\nCalling final LLM to generate response...`);
                },
                
                onLlmStream: (chunk) => { fullResponse += chunk; },
                onLlmEnd: async () => {
                    outputChannel.appendLine(`\n--- [LLM END] ---`);
                    outputChannel.appendLine(`Final Response (length: ${fullResponse.length}):\n${fullResponse}`);
                    
                    const outputDir = vscode.Uri.joinPath(codewikiDir, 'output');
                    await vscode.workspace.fs.createDirectory(outputDir);
                    const outputFilePath = vscode.Uri.joinPath(outputDir, `${path.parse(selectedFileName).name}-result-${Date.now()}.md`);
                    await vscode.workspace.fs.writeFile(outputFilePath, Buffer.from(fullResponse, 'utf8'));
                    
                    outputChannel.appendLine(`\n[SUCCESS] Agent run finished. Result saved to: ${outputFilePath.fsPath}`);
                    vscode.window.showInformationMessage(`Agent run successful. Output saved.`);
                },
                onError: (error) => {
                    const errorMsg = `Agent execution failed: ${error.message}`;
                    outputChannel.appendLine(`\n--- [ERROR] ---\n${errorMsg}\n${error.stack}\n---`);
                    vscode.window.showErrorMessage(errorMsg);
                }
            };
            
            await runActionPrompt({ yamlContent, userInputs, modelConfig: defaultConfig, tools, callbacks });

        } catch (error: any) {
            const finalError = `[FATAL] An unexpected error occurred: ${error.message}`;
            outputChannel.appendLine(finalError);
            vscode.window.showErrorMessage(finalError);
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}