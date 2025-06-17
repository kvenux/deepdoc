// src/extension/extension.ts (完整文件)

import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { CodeWikiViewProvider } from './CodeWikiViewProvider';
import { StateManager } from './StateManager';
// highlight-start
// 导入新的 Map-Reduce 流程执行器
import { runMapReduceAgent } from './agentOrchestrator';
// 不再需要导入旧的 agentRunner 或它的依赖
// highlight-end

export function activate(context: vscode.ExtensionContext) {
    const provider = new CodeWikiViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeWikiViewProvider.viewType, provider)
    );

    // =========================================================================
    // == 注册一个灵活的、可交互的 Agent 运行命令
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
            outputChannel.appendLine(`[INFO] User selected prompt: ${selectedFileName}`);

            // 4. 读取并解析选中的 YAML 文件
            const promptUri = vscode.Uri.joinPath(codewikiDir, selectedFileName);
            const fileContent = await vscode.workspace.fs.readFile(promptUri);
            const yamlContent = Buffer.from(fileContent).toString('utf-8');
            // 初步解析以获取元数据和判断类型
            const actionPrompt = yaml.load(yamlContent) as any;
            outputChannel.appendLine(`[INFO] Successfully loaded and parsed: ${actionPrompt.title || selectedFileName}`);
            
            // 5. 动态获取用户输入
            const userInputs: Record<string, string> = {};
            if (actionPrompt.input_variables && Array.isArray(actionPrompt.input_variables)) {
                outputChannel.appendLine(`[INFO] Requesting user inputs...`);
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
                outputChannel.appendLine(`[INFO] No 'input_variables' defined in the prompt. Proceeding without user input.`);
            }

            outputChannel.appendLine(`\n--- Starting Agent Execution ---`);
            
            // 6. 获取模型配置
            const stateManager = new StateManager(context.globalState);
            const modelConfigs = await stateManager.getModelConfigs();
            const defaultConfig = modelConfigs.find(c => c.isDefault) || modelConfigs[0];
            if (!defaultConfig) { throw new Error("No default model config found."); }
            
            // highlight-start
            // =========================================================================
            // == 核心修改：根据YAML内容选择不同的执行器
            // =========================================================================
            if (actionPrompt.map_prompt_template && actionPrompt.reduce_prompt_template) {
                // 这是新的 Map-Reduce Agent
                outputChannel.appendLine("[INFO] Detected Map-Reduce Agent type. Starting orchestrator...");
                await runMapReduceAgent(yamlContent, userInputs, defaultConfig, outputChannel);

            } else if (actionPrompt.tool_chain && actionPrompt.llm_prompt_template) {
                // 这是旧的 Tool-Chain Agent
                outputChannel.appendLine("[ERROR] Detected Tool-Chain Agent type.");
                // 旧的 runActionPrompt 逻辑应该在这里被调用，但我们在此示例中将其标记为未实现
                // 以便专注于新的 Map-Reduce 流程。
                // await runActionPrompt({ yamlContent, userInputs, modelConfig: defaultConfig, tools, callbacks });
                throw new Error("Standard Tool-Chain agent runner is not connected in this version. Please use a Map-Reduce prompt YAML file.");
            } else {
                throw new Error("Unknown or invalid Action Prompt YAML format. It must contain either ('map_prompt_template' and 'reduce_prompt_template') or ('tool_chain' and 'llm_prompt_template').");
            }
            // highlight-end

        } catch (error: any) {
            const finalError = `[FATAL] An unexpected error occurred: ${error.message}`;
            outputChannel.appendLine(finalError);
            vscode.window.showErrorMessage(finalError);
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}