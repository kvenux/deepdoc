import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
// highlight-start
import { StructuredTool } from '@langchain/core/tools';
// highlight-end

/**
 * 获取当前工作区的根路径。
 * @returns {string} 工作区根目录的绝对路径。
 * @throws {Error} 如果没有打开的工作区。
 */
function getWorkspaceRoot(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error("No workspace folder is open. Please open a project folder.");
    }
    return workspaceFolders[0].uri.fsPath;
}

/**
 * 一个LangChain工具，用于获取指定目录下所有文件的路径和内容摘要。
 * 摘要是文件的前20行。
 */
// highlight-start
export class GetFileSummariesTool extends StructuredTool {
// highlight-end
    static lc_name() {
        return "GetFileSummariesTool";
    }

    name = "get_file_summaries";
    description = "Gets the path and a content summary (first 20 lines) of all files in a given directory. Useful for understanding a module's structure before reading full files.";

    // 使用Zod定义工具的输入模式
    schema = z.object({
        path: z.string().describe("The relative path to the directory from the workspace root."),
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
                return `No files found in the directory: ${relativePath}`;
            }

            return fileSummaries.join('\n');
        } catch (error: any) {
            return `Error getting file summaries for path "${relativePath}": ${error.message}`;
        }
    }
}


/**
 * 一个LangChain工具，根据提供的文件路径列表，获取这些文件的完整内容。
 */
// highlight-start
export class GetFilesContentByListTool extends StructuredTool {
// highlight-end
    static lc_name() {
        return "GetFilesContentByListTool";
    }

    name = "get_files_content_by_list";
    description = "Reads the full content of files specified in a list of relative paths. The list should be the output of a file selection tool.";

    schema = z.object({
        file_paths: z.array(z.string()).describe("An array of relative paths from the workspace root for the files to be read."),
    });

    protected async _call({ file_paths }: z.infer<typeof this.schema>): Promise<string> {
        if (!file_paths || file_paths.length === 0) {
            return "Input file list is empty. No content to read.";
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
                    return `--- FILE: ${relativePath.replace(/\\/g, '/')} ---\nERROR: Could not read file. ${fileError.message}\n--- END OF FILE ---\n`;
                }
            });

            const allContents = await Promise.all(contentPromises);
            return allContents.join('\n');

        } catch (error: any) {
            // 捕获 getWorkspaceRoot 的错误
            return `Error getting files content: ${error.message}`;
        }
    }
}