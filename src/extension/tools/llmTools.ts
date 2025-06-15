// src/extension/tools/llmTools.ts

import { z } from 'zod';
import { StructuredTool } from '@langchain/core/tools';
import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';

// 这是 FileSelectorLLMTool 内部使用的 Prompt 模板
const SELECTION_PROMPT = `You are an expert software engineer assistant. Your task is to analyze a list of file summaries and select the most relevant files based on a user's task description.

Analyze the following file summaries:
---
{file_summaries}
---

The user's task is: "{task_description}"

Based on this, which files are the most critical for understanding and completing the task?

Please provide your answer as a clean, comma-separated list of file paths. Do NOT include any other text, explanations, or formatting.

Example response:
src/common/types.ts,src/extension/LLMService.ts,src/webview/views/ChatView.ts
`;

/**
 * 一个内部类，代表了 LLM-as-a-Tool 的具体实现。
 * 我们不直接导出它，而是通过工厂函数创建。
 */
class FileSelectorLLMTool extends StructuredTool {
    static lc_name() {
        return "FileSelectorLLMTool";
    }

    name = "file_selector_llm_tool";
    description = "Analyzes a list of file summaries and a task description to intelligently select the most relevant files. The output is an array of file paths.";
    
    // 该工具的输入 schema
    schema = z.object({
        file_summaries: z.string().describe("A single string containing all file summaries, separated by markers."),
        task_description: z.string().describe("A description of the goal or task to guide the file selection."),
    });

    // 持有传入的 LLM 实例
    private llm: BaseLanguageModel;

    constructor(llm: BaseLanguageModel) {
        super(); // 调用父类构造函数
        this.llm = llm;
    }

    protected async _call({ file_summaries, task_description }: z.infer<typeof this.schema>): Promise<string> {
        try {
            // 1. 构建专门用于文件筛选的 Prompt
            const selectionPrompt = ChatPromptTemplate.fromTemplate(SELECTION_PROMPT);

            // 2. 构建一个临时的、用于该工具内部的 LangChain "子链"
            //    它接收格式化的 prompt，调用 LLM，然后解析出字符串结果。
            const selectionChain = selectionPrompt
                .pipe(this.llm)
                .pipe(new StringOutputParser());

            // 3. 调用子链来执行 LLM 推理
            console.log("Invoking file_selector_llm_tool with task:", task_description);
            const llmResult = await selectionChain.invoke({
                file_summaries,
                task_description
            });
            console.log("File selector LLM raw response:", llmResult);

            // 4. 解析 LLM 返回的结果
            //    LLM 可能返回一些额外的空格或换行符，我们进行清理。
            //    我们期望的结果是 "path/a.ts, path/b.ts, ..."
            const cleanedResult = llmResult.replace(/```/g, '').trim(); // 移除代码块标记和多余空格
            const filePaths = cleanedResult.split(',')
                .map(p => p.trim())
                .filter(p => p.length > 0 && p.includes('/')); // 过滤掉空字符串和无效条目

            if (filePaths.length === 0) {
                console.warn("File selector LLM did not return any valid file paths.");
                return "[]"; // 返回一个表示空数组的JSON字符串
            }
            
            // 5. 将结果（一个字符串数组）序列化为 JSON 字符串返回。
            //    这是因为 LangChain 工具的标准输出是 string。
            //    我们的自定义 Agent Executor (将在下一阶段实现) 将负责解析这个JSON。
            return JSON.stringify(filePaths);

        } catch (error: any) {
            console.error("Error in FileSelectorLLMTool:", error);
            return `Error during file selection LLM call: ${error.message}`;
        }
    }
}

/**
 * 工厂函数，用于创建和配置 FileSelectorLLMTool。
 * 这是我们从外部调用的函数。
 * @param llm - 一个配置好的、可用于调用的 BaseLanguageModel 实例。
 * @returns {StructuredTool} 一个配置好的、可直接使用的工具实例。
 */
export function createFileSelectorLLMTool(llm: BaseLanguageModel): StructuredTool {
    return new FileSelectorLLMTool(llm);
}