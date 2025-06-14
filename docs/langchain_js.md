# Langchain.js 使用指南

本文档旨在介绍 Langchain.js 的基本使用方法，包括如何进行大模型请求、构建 Agent 应用，并探讨在 VSCode 插件中实现大模型请求的思路。

## 1. Langchain.js 简介

LangChain 是一个用于开发由大型语言模型 (LLM) 提供支持的应用程序的框架。它提供了一套工具、组件和接口，简化了与 LLM 的交互，并支持构建复杂的链式应用和 Agent。Langchain.js 是其 JavaScript/TypeScript 版本。

## 2. 安装 Langchain.js

您可以使用 npm、yarn 或 pnpm 安装 Langchain.js：

```bash
npm install -S langchain @langchain/core
# 或者
yarn add langchain @langchain/core
# 或者
pnpm add langchain @langchain/core
```

## 3. 模型请求 (LLM Invocation)

Langchain.js 提供了多种方式与大模型进行交互。

### 3.1 基本模型调用

通过 `ChatOpenAI` 等类初始化模型，并直接调用 `invoke` 方法。

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

// 设置 OpenAI API Key
process.env.OPENAI_API_KEY = "YOUR_API_KEY";

const llm = new ChatOpenAI({ model: "gpt-4o" });

async function basicInvocation() {
  const response = await llm.invoke([new HumanMessage("你好，LangChain！")]);
  console.log(response.content);
}

basicInvocation();
```

### 3.2 聊天模型调用与提示模板

使用 `ChatPromptTemplate` 构建结构化的聊天提示，并将其与模型连接。

```typescript
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";

const prompt = ChatPromptTemplate.fromTemplate(
  `回答以下问题：\n{question}`
);

const model = new ChatOpenAI({
  temperature: 0.8,
});

const outputParser = new StringOutputParser();

const chain = prompt.pipe(model).pipe(outputParser);

async function chatInvocation() {
  const result = await chain.invoke({
    question: "天空为什么是蓝色的？",
  });
  console.log(result);
}

chatInvocation();
```

### 3.3 流式响应

对于需要实时显示模型输出的场景，可以使用流式响应。

```typescript
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";

const prompt = ChatPromptTemplate.fromTemplate(
  `回答以下问题：\n{question}`
);

const model = new ChatOpenAI({
  temperature: 0.8,
});

const outputParser = new StringOutputParser();

const chain = prompt.pipe(model).pipe(outputParser);

async function streamInvocation() {
  const stream = await chain.stream({
    question: "为什么地球是圆的？",
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk);
  }
}

streamInvocation();
```

## 4. Agent 应用 (Agent Applications)

Agent 允许模型根据工具的描述决定采取哪些行动以及以何种顺序采取行动。

### 4.1 工具定义与绑定

定义一个工具，并将其绑定到 LLM。

```typescript
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

// 示例工具：获取当前天气
const weatherTool = tool(
  async ({ location }: { location: string }) => {
    // 实际应用中会调用天气 API
    if (location === "旧金山") {
      return "旧金山现在是晴天，气温20摄氏度。";
    }
    return "无法获取该地点天气信息。";
  },
  {
    name: "get_current_weather",
    description: "获取指定地点的当前天气信息。",
    schema: z.object({
      location: z.string().describe("地点名称"),
    }),
  }
);

const llmWithTools = new ChatOpenAI({ model: "gpt-4o", temperature: 0 }).bindTools([weatherTool]);

async function useTool() {
  const response = await llmWithTools.invoke([
    new HumanMessage("旧金山的天气怎么样？"),
  ]);
  console.log(response.tool_calls); // 打印模型决定调用的工具
}

useTool();
```

### 4.2 ReAct Agent

ReAct (Reasoning and Acting) Agent 是一种流行的 Agent 模式，它结合了推理和行动。

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";

// 定义一个简单的工具
const searchTool = tool(
  async ({ query }: { query: string }) => {
    return `搜索结果：关于 "${query}" 的信息...`;
  },
  {
    name: "search",
    description: "根据查询字符串搜索信息。",
    schema: z.object({
      query: z.string().describe("搜索查询"),
    }),
  }
);

const llm = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
const tools = [searchTool];

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是一个有用的助手，可以回答问题并使用工具。"],
  ["placeholder", "{messages}"],
]);

const agentExecutor = createReactAgent({
  llm,
  tools,
  messageModifier: prompt,
  checkpointSaver: new MemorySaver(), // 用于保存对话历史
});

async function runAgent() {
  const result = await agentExecutor.invoke({
    messages: [{ role: "user", content: "请帮我搜索一下 LangChain 是什么？" }],
  });
  console.log(result.messages[result.messages.length - 1].content);
}

runAgent();
```

### 4.3 RAG (Retrieval Augmented Generation)

RAG 结合了检索和生成，通过从外部知识库中检索相关信息来增强 LLM 的回答。

```typescript
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { createRetrievalChain } from "langchain/chains/retrieval";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

async function runRAG() {
  const llm = new ChatOpenAI({ model: "gpt-4o" });

  // 1. 加载文档
  const loader = new CheerioWebBaseLoader(
    "https://lilianweng.github.io/posts/2023-06-23-agent/" // 示例文章
  );
  const docs = await loader.load();

  // 2. 分割文档
  const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const splits = await textSplitter.splitDocuments(docs);

  // 3. 创建向量存储并生成嵌入
  const embeddings = new OpenAIEmbeddings();
  const vectorStore = await MemoryVectorStore.fromDocuments(splits, embeddings);

  // 4. 创建检索器
  const retriever = vectorStore.asRetriever();

  // 5. 定义 QA 提示
  const systemPrompt =
    "你是一个问答助手。使用以下检索到的上下文来回答问题。如果不知道答案，就说不知道。最多三句话，保持答案简洁。" +
    "\n\n" +
    "{context}";

  const qaPrompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
  ]);

  // 6. 创建文档组合链
  const questionAnswerChain = await createStuffDocumentsChain({
    llm,
    prompt: qaPrompt,
  });

  // 7. 创建检索链
  const ragChain = await createRetrievalChain({
    retriever: retriever,
    combineDocsChain: questionAnswerChain,
  });

  // 8. 调用 RAG 链
  const result = await ragChain.invoke({
    chat_history: [
      new HumanMessage("什么是 Agent？"),
      new AIMessage("Agent 是一个能够感知环境、进行推理并采取行动的实体。"),
    ],
    input: "Agent 的核心组件有哪些？",
  });

  console.log(result.answer);
}

runRAG();
```

## 5. VSCode 插件中大模型请求的实现思路

在 VSCode 插件中实现大模型请求通常涉及以下几个关键部分：

### 5.1 前端 (Webview) 与后端 (Extension) 通信

VSCode 插件通常由两部分组成：
*   **Extension (后端)**：运行在 Node.js 环境中，可以访问 VSCode API 和 Node.js 模块，负责与大模型 API 进行实际交互。
*   **Webview (前端)**：一个嵌入在 VSCode 中的网页，用于构建用户界面。

Webview 和 Extension 之间需要通过消息传递机制进行通信。

*   **Webview 向 Extension 发送请求**：
    ```typescript
    // webview/main.ts (或相关视图文件)
    import { vscode } from "./vscode"; // 封装的 vscode API

    function sendRequestToLLM(prompt: string) {
      vscode.postMessage({
        command: "callLLM",
        text: prompt,
      });
    }
    ```

*   **Extension 接收 Webview 请求并处理**：
    ```typescript
    // extension/CodeWikiViewProvider.ts (或相关视图提供者)
    import * as vscode from 'vscode';
    import { LLMService } from './LLMService'; // 你的 LLM 服务

    export class CodeWikiViewProvider implements vscode.WebviewViewProvider {
      private _view?: vscode.WebviewView;
      private _llmService: LLMService;

      constructor(private readonly _extensionUri: vscode.Uri) {
        this._llmService = new LLMService();
      }

      public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
      ) {
        this._view = webviewView;

        webviewView.webview.options = {
          enableScripts: true,
          localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
          switch (message.command) {
            case "callLLM":
              try {
                const response = await this._llmService.callLLM(message.text);
                webviewView.webview.postMessage({
                  command: "llmResponse",
                  text: response,
                });
              } catch (error) {
                webviewView.webview.postMessage({
                  command: "llmError",
                  text: error.message,
                });
              }
              return;
          }
        });
      }

      // ... 其他方法
    }
    ```

### 5.2 后端 LLMService 的实现

`LLMService.ts` 文件将负责封装 Langchain.js 的逻辑，与大模型 API 进行实际交互。

```typescript
// src/extension/LLMService.ts
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";

export class LLMService {
  private llm: ChatOpenAI;

  constructor() {
    // 确保 OPENAI_API_KEY 已在环境变量中设置，或者从 VSCode 配置中获取
    // 例如：this.llm = new ChatOpenAI({ apiKey: vscode.workspace.getConfiguration('yourPlugin').get('openaiApiKey') });
    this.llm = new ChatOpenAI({ model: "gpt-4o", temperature: 0.7 });
  }

  public async callLLM(promptText: string): Promise<string> {
    const prompt = ChatPromptTemplate.fromTemplate(`请回答以下问题：\n{question}`);
    const outputParser = new StringOutputParser();
    const chain = prompt.pipe(this.llm).pipe(outputParser);

    try {
      const response = await chain.invoke({ question: promptText });
      return response;
    } catch (error) {
      console.error("调用 LLM 失败:", error);
      throw new Error("无法获取 LLM 响应。请检查您的 API 密钥和网络连接。");
    }
  }

  // 可以添加更多方法，例如：
  // public async callAgent(query: string): Promise<string> { ... }
  // public async callRAG(query: string, context: string[]): Promise<string> { ... }
}
```

### 5.3 环境变量配置

在 VSCode 插件中，通常不建议将 API 密钥硬编码。可以通过以下方式管理 API 密钥：

*   **VSCode 配置**：在插件的 `package.json` 中定义配置项，用户可以在 VSCode 设置中输入他们的 API 密钥。
    ```json
    // package.json
    "contributes": {
      "configuration": {
        "title": "Your Plugin Settings",
        "properties": {
          "yourPlugin.openaiApiKey": {
            "type": "string",
            "description": "Your OpenAI API Key.",
            "scope": "resource"
          }
        }
      }
    }
    ```
    然后在 Extension 中读取：
    ```typescript
    const apiKey = vscode.workspace.getConfiguration('yourPlugin').get('openaiApiKey');
    this.llm = new ChatOpenAI({ apiKey: apiKey as string });
    ```
*   **环境变量**：用户可以在其系统环境变量中设置 `OPENAI_API_KEY`。在 Node.js 环境中，可以通过 `process.env.OPENAI_API_KEY` 访问。

通过上述步骤，您可以在 VSCode 插件中有效地集成 Langchain.js，实现大模型请求和更复杂的 Agent 应用。
