// src/extension/tools/fileSystemTools.ts (完整文件)

import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
import { StructuredTool } from '@langchain/core/tools';

/**
 * 获取当前工作区的根路径。
 * @returns {string} 工作区根目录的绝对路径。
 * @throws {Error} 如果没有打开的工作区。
 */
function getWorkspaceRoot(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error("没有打开的工作区。请先打开一个项目文件夹。");
    }
    return workspaceFolders[0].uri.fsPath;
}

/**
 * 一个LangChain工具，用于获取指定目录下所有文件的路径和内容摘要。
 * 摘要是文件的前20行。
 */
export class GetFileSummariesTool extends StructuredTool {
    static lc_name() {
        return "GetFileSummariesTool";
    }

    name = "get_file_summaries";
    description = "获取指定目录中所有文件的路径和内容摘要（文件的前20行）。用于在阅读完整文件之前，快速了解一个模块的结构。";

    schema = z.object({
        path: z.string().describe("从工作区根目录出发的相对路径。"),
    });

    protected async _call({ path: relativePath }: z.infer<typeof this.schema>): Promise<string> {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const absolutePath = path.join(workspaceRoot, relativePath);

            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absolutePath));
            const fileSummaries: string[] = [];

            for (const [name, type] of entries) {
                if (type === vscode.FileType.File) {
                    const filePath = path.join(absolutePath, name);
                    const fileUri = vscode.Uri.file(filePath);
                    
                    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = Buffer.from(contentBytes).toString('utf-8');
                    const summary = content.split('\n').slice(0, 20).join('\n');
                    
                    const fileRelativePath = path.relative(workspaceRoot, filePath);

                    fileSummaries.push(
                        `--- FILE: ${fileRelativePath.replace(/\\/g, '/')} ---\n${summary}\n--- END OF SUMMARY ---\n`
                    );
                }
            }

            if (fileSummaries.length === 0) {
                return `在目录 "${relativePath}" 中没有找到任何文件。`;
            }

            return fileSummaries.join('\n');
        } catch (error: any) {
            return `获取路径 "${relativePath}" 的文件摘要时出错: ${error.message}`;
        }
    }
}


/**
 * 一个LangChain工具，根据提供的文件路径列表，获取这些文件的完整内容。
 */
export class GetFilesContentByListTool extends StructuredTool {
    static lc_name() {
        return "GetFilesContentByListTool";
    }

    name = "get_files_content_by_list";
    description = "根据一个包含相对路径的列表，读取这些文件的完整内容。这个列表通常是文件选择工具的输出。";

    schema = z.object({
        file_paths: z.array(z.string()).describe("一个包含文件相对路径的数组，路径从工作区根目录开始计算。"),
    });

    protected async _call({ file_paths }: z.infer<typeof this.schema>): Promise<string> {
        if (!file_paths || file_paths.length === 0) {
            return "输入的文件列表为空，没有内容可以读取。";
        }

        try {
            const workspaceRoot = getWorkspaceRoot();
            const contentPromises = file_paths.map(async (relativePath) => {
                const absolutePath = path.join(workspaceRoot, relativePath);
                const fileUri = vscode.Uri.file(absolutePath);
                
                try {
                    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = Buffer.from(contentBytes).toString('utf-8');
                    return `--- FILE: ${relativePath.replace(/\\/g, '/')} ---\n${content}\n--- END OF FILE ---\n`;
                } catch (fileError: any) {
                    // 如果单个文件读取失败，返回错误信息而不是让整个工具失败
                    return `--- FILE: ${relativePath.replace(/\\/g, '/')} ---\n错误: 无法读取文件。 ${fileError.message}\n--- END OF FILE ---\n`;
                }
            });

            const allContents = await Promise.all(contentPromises);
            return allContents.join('\n');

        } catch (error: any) {
            // 捕获 getWorkspaceRoot 的错误
            return `获取文件内容时出错: ${error.message}`;
        }
    }
}

// highlight-start
/**
 * 一个LangChain工具，用于递归获取指定目录下所有文件的完整内容。
 */
export class GetAllFilesContentTool extends StructuredTool {
    static lc_name() {
        return "GetAllFilesContentTool";
    }

    name = "get_all_files_content";
    description = "递归地获取指定目录及其所有子目录中所有文件的完整内容。当需要对一个模块的所有代码进行全面分析时使用。";

    schema = z.object({
        path: z.string().describe("从工作区根目录出发的相对路径。"),
    });

    /**
     * 递归遍历目录并收集文件内容。
     * @param dirUri 要遍历的目录的 URI。
     * @param workspaceRoot 工作区的根路径，用于计算相对路径。
     * @returns 一个包含文件内容和标记的字符串数组。
     */
    private async _traverseDirectory(dirUri: vscode.Uri, workspaceRoot: string): Promise<string[]> {
        let allContents: string[] = [];
        const entries = await vscode.workspace.fs.readDirectory(dirUri);

        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(dirUri, name);
            if (type === vscode.FileType.File) {
                const fileRelativePath = path.relative(workspaceRoot, entryUri.fsPath).replace(/\\/g, '/');
                try {
                    const contentBytes = await vscode.workspace.fs.readFile(entryUri);
                    const content = Buffer.from(contentBytes).toString('utf-8');
                    allContents.push(`--- FILE: ${fileRelativePath} ---\n${content}\n--- END OF FILE ---\n`);
                } catch (fileError: any) {
                    allContents.push(`--- FILE: ${fileRelativePath} ---\n错误: 无法读取文件。 ${fileError.message}\n--- END OF FILE ---\n`);
                }
            } else if (type === vscode.FileType.Directory) {
                // 如果是目录，则递归调用
                const subDirContents = await this._traverseDirectory(entryUri, workspaceRoot);
                allContents = allContents.concat(subDirContents);
            }
        }
        return allContents;
    }

    protected async _call({ path: relativePath }: z.infer<typeof this.schema>): Promise<string> {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const absolutePath = path.join(workspaceRoot, relativePath);
            const dirUri = vscode.Uri.file(absolutePath);

            const allContents = await this._traverseDirectory(dirUri, workspaceRoot);

            if (allContents.length === 0) {
                return `在目录 "${relativePath}" 及其子目录中没有找到任何文件。`;
            }

            return allContents.join('\n');
        } catch (error: any) {
            return `递归获取路径 "${relativePath}" 的所有文件内容时出错: ${error.message}`;
        }
    }
}

/**
 * 一个LangChain工具，用于生成指定路径的目录树结构。
 */
export class GetDirectoryTreeTool extends StructuredTool {
    static lc_name() {
        return "GetDirectoryTreeTool";
    }

    name = "get_directory_tree";
    description = "生成给定路径的目录和文件树状结构图。用于快速了解项目的整体文件布局。";

    schema = z.object({
        path: z.string().describe("从工作区根目录出发的相对路径。"),
    });

    /**
     * 递归生成目录树。
     * @param dirUri 要生成树的目录的 URI。
     * @param displayRootPath 用于显示路径的根，例如 "." 或 "project"。
     * @returns 一个包含所有路径的字符串数组。
     */
    private async _generateTree(dirUri: vscode.Uri, displayRootPath: string): Promise<string[]> {
        let treeLines: string[] = [];
        const entries = await vscode.workspace.fs.readDirectory(dirUri);

        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(dirUri, name);
            const entryDisplayPath = path.join(displayRootPath, name).replace(/\\/g, '/');

            treeLines.push(entryDisplayPath);

            if (type === vscode.FileType.Directory) {
                const subTreeLines = await this._generateTree(entryUri, entryDisplayPath);
                treeLines = treeLines.concat(subTreeLines);
            }
        }
        return treeLines;
    }

    protected async _call({ path: relativePath }: z.infer<typeof this.schema>): Promise<string> {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const absolutePath = path.join(workspaceRoot, relativePath);
            const dirUri = vscode.Uri.file(absolutePath);

            // 确定显示的根路径
            const displayRoot = relativePath === '.' || relativePath === '' ? '.' : `./${relativePath}`;
            
            let treeLines = [displayRoot];
            const subTree = await this._generateTree(dirUri, displayRoot);
            treeLines = treeLines.concat(subTree);

            return treeLines.join('\n');
        } catch (error: any) {
            return `生成路径 "${relativePath}" 的目录树时出错: ${error.message}`;
        }
    }
}
// highlight-end