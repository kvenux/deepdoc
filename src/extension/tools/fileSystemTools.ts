// src/extension/tools/fileSystemTools.ts (完整文件)

import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
import { StructuredTool } from '@langchain/core/tools';
import { languageFilters, GENERIC_EXCLUDE, LanguageFilter } from '../config/fileFilters';

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
 * 新增的辅助函数，用于递归获取过滤后的文件路径。
 * @param dirUri 起始目录的URI
 * @param language 用于选择过滤规则的语言
 * @returns {Promise<vscode.Uri[]>} 过滤后的文件URI列表
 */
async function getFilteredFilePathsRecursive(dirUri: vscode.Uri, language: string = 'unknown'): Promise<vscode.Uri[]> {
    let files: vscode.Uri[] = [];
    const filter: LanguageFilter = languageFilters[language.toLowerCase()] || languageFilters.unknown;

    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);

        for (const [name, type] of entries) {
            // 检查是否在通用排除列表中
            if (GENERIC_EXCLUDE.includes(name)) {
                continue;
            }

            const entryUri = vscode.Uri.joinPath(dirUri, name);
            if (type === vscode.FileType.File) {
                const extension = path.extname(name);
                const shouldInclude = filter.include.includes(extension);
                const shouldExclude = filter.exclude.some(pattern => name.endsWith(pattern));

                if (shouldInclude && !shouldExclude) {
                    files.push(entryUri);
                }
            } else if (type === vscode.FileType.Directory) {
                files = files.concat(await getFilteredFilePathsRecursive(entryUri, language));
            }
        }
    } catch (error) {
        console.warn(`Could not read directory ${dirUri.fsPath}:`, error);
    }
    return files;
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
        language: z.string().optional().describe("项目的编程语言 (例如 'typescript', 'python')，用于智能过滤文件。如果未提供，则使用通用规则。"),
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
        language: z.string().optional().describe("项目的编程语言 (例如 'typescript', 'python')，用于智能过滤文件。如果未提供，则使用通用规则。"),
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

    protected async _call({ path: relativePath, language }: z.infer<typeof this.schema>): Promise<string> {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const absolutePath = path.join(workspaceRoot, relativePath);
            const dirUri = vscode.Uri.file(absolutePath);

            // highlight-start
            // 使用新的过滤辅助函数
            const fileUris = await getFilteredFilePathsRecursive(dirUri, language);
            // highlight-end

            if (fileUris.length === 0) {
                return `在目录 "${relativePath}" 及其子目录中没有找到与语言 '${language}' 相关的任何文件。`;
            }
            
            const contentPromises = fileUris.map(async (uri) => {
                 const fileRelativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                 try {
                    const contentBytes = await vscode.workspace.fs.readFile(uri);
                    const content = Buffer.from(contentBytes).toString('utf-8');
                    return `--- FILE: ${fileRelativePath} ---\n${content}\n--- END OF FILE ---\n`;
                 } catch (fileError: any) {
                    return `--- FILE: ${fileRelativePath} ---\n错误: 无法读取文件。 ${fileError.message}\n--- END OF FILE ---\n`;
                 }
            });
            
            const allContents = await Promise.all(contentPromises);
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
    // 更新描述，告知 AI 此工具输出紧凑的树状结构以节省 Token
    description = "生成给定路径的目录和文件树状结构图，并以紧凑的、节省 Token 的格式展示。会自动过滤掉常见的非源码目录（如 .git, .vscode, build, target 等）。用于快速了解项目的整体文件布局。";

    schema = z.object({
        path: z.string().describe("从工作区根目录出发的相对路径。"),
    });

    private readonly ignoreDirs: Set<string> = new Set([
        '.git',
        '.vscode',
        '.idea',
        'node_modules',
        'build',
        'dist',
        'target',
        'out',
        'bin',
        '.codewiki',
        '__pycache__',
    ]);

    /**
     * 递归生成格式化的目录树。
     * @param dirUri 要生成树的目录的 URI。
     * @param prefix 用于排版的树状前缀字符串 (例如 "│   " 或 "    ")。
     * @returns 一个包含格式化后树形结构行的字符串数组。
     */
    private async _generateTree(dirUri: vscode.Uri, prefix: string): Promise<string[]> {
        let treeLines: string[] = [];
        const entries = await vscode.workspace.fs.readDirectory(dirUri);

        // 先过滤掉需要忽略的目录/文件
        const filteredEntries = entries.filter(([name, _]) => !this.ignoreDirs.has(name));
        const count = filteredEntries.length;

        for (let i = 0; i < count; i++) {
            const [name, type] = filteredEntries[i];
            const isLast = i === count - 1; // 判断是否是当前目录的最后一个条目

            // 根据是否为最后一个条目，选择不同的连接符
            const connector = isLast ? '└── ' : '├── ';
            treeLines.push(`${prefix}${connector}${name}`);

            if (type === vscode.FileType.Directory) {
                // 为下一层递归计算新的前缀
                // 如果当前是最后一个，下一层的前缀使用空格；否则使用竖线连接
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                const subTreeLines = await this._generateTree(vscode.Uri.joinPath(dirUri, name), newPrefix);
                treeLines = treeLines.concat(subTreeLines);
            }
        }
        return treeLines;
    }

    protected async _call({ path: relativePath }: z.infer<typeof this.schema>): Promise<string> {
        try {
            const workspaceRoot = getWorkspaceRoot();
            if (!relativePath || relativePath === '/' || relativePath === '\\') {
                relativePath = '.';
            }
            const absolutePath = path.join(workspaceRoot, relativePath);
            const dirUri = vscode.Uri.file(absolutePath);

            try {
                const stat = await vscode.workspace.fs.stat(dirUri);
                if (stat.type !== vscode.FileType.Directory) {
                    return `错误：路径 "${relativePath}" 不是一个目录。`;
                }
            } catch (e) {
                return `错误：路径 "${relativePath}" 不存在或无法访问。`;
            }

            const displayRoot = relativePath === '.' ? '.' : `./${relativePath.replace(/\\/g, '/')}`;

            let treeLines = [displayRoot];
            // 初始调用时，前缀为空字符串 ""
            const subTree = await this._generateTree(dirUri, "");
            treeLines = treeLines.concat(subTree);

            if (treeLines.length === 1) {
                return `${displayRoot} (目录为空或所有内容均被过滤)`;
            }

            return treeLines.join('\n');
        } catch (error: any) {
            return `生成路径 "${relativePath}" 的目录树时出错: ${error.message}`;
        }
    }
}
