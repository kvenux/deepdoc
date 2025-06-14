# LangGraph.js 使用指南

LangGraph.js 是一个用于构建、编排和部署 AI 代理工作流和复杂 LLM 应用程序的 JavaScript/TypeScript 框架，它通过可组合的图（graphs）实现，并集成了持久化、流式传输、人机协作和内存支持。

## 核心概念

LangGraph 的核心是 `StateGraph`，它允许你定义一个有状态的图，其中包含节点（nodes）和边（edges）。节点代表图中的一个步骤或一个代理，而边则定义了这些步骤之间的流转。

### 状态（State）

`StateGraph` 管理着一个共享的状态对象，这个状态在图中的节点之间传递。你可以通过 `Annotation.Root` 或 `TypedDict` 来定义状态的模式（schema）。例如：

```typescript
import { Annotation } from "@langchain/langgraph";

const GraphState = Annotation.Root({
  messages: Annotation.ArrayOf(Annotation.Object()), // 消息列表
  summary: Annotation<string>({
    reducer: (_, action) => action,
    default: () => "",
  }) // 对话摘要
});
```

### 节点（Nodes）

节点是图中的执行单元。它们可以是调用语言模型、执行工具或任何自定义逻辑的函数。

例如，一个调用模型的节点：

```typescript
const callModel = async (state: typeof GraphAnnotation.State): Promise<Partial<typeof GraphAnnotation.State>> => {
  const { messages } = state;
  const response = await model.invoke(messages);
  return { messages: [response] };
};
```

一个工具节点，用于执行工具调用：

```typescript
import { ToolNode } from "@langchain/langgraph/prebuilt";
// ...
const toolNode = new ToolNode(tools); // tools 是一个工具数组
```

### 边（Edges）

边定义了节点之间的流转。LangGraph 支持两种类型的边：

1.  **普通边（Normal Edges）**: 从一个节点直接连接到另一个节点。
    ```typescript
    .addEdge("tools", "agent") // 从 "tools" 节点到 "agent" 节点
    ```
2.  **条件边（Conditional Edges）**: 根据某个函数的返回值，动态地决定下一个要执行的节点。
    ```typescript
    .addConditionalEdges(
      "agent", // 起始节点
      shouldContinue, // 决定下一个节点的函数
      {
        // 映射：函数返回值 -> 下一个节点
        continue: "action",
        end: END, // END 是一个特殊节点，表示图的结束
      },
    )
    ```

### 编译图（Compiling the Graph）

定义好节点和边之后，你需要编译图才能执行它：

```typescript
const app = workflow.compile();
```

编译后的图是一个 LangChain Runnable，这意味着你可以像使用任何其他 Runnable 一样使用它，例如调用 `invoke` 或 `stream` 方法。

## 构建代理工作流

LangGraph 非常适合构建复杂的代理工作流，例如 ReAct 代理或多代理系统。

### ReAct 代理示例

一个基本的 ReAct 代理工作流通常包括一个代理节点（调用模型进行决策）和一个工具节点（执行工具）。

```typescript
import { END, START, StateGraph, MemorySaver, InMemoryStore } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";

// 定义工具
const tools = [getFavoritePets, updateFavoritePets]; // 假设这些工具已定义

// 初始化模型
const model = new ChatOpenAI({ model: "gpt-4o" });

// 定义路由函数，根据模型输出决定下一步
const routeMessage = (state: typeof MessagesAnnotation.State) => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1] as AIMessage;
  if (!lastMessage?.tool_calls?.length) {
    return END; // 如果没有工具调用，则结束
  }
  return "tools"; // 否则，调用工具
};

// 定义调用模型的节点
const callModel = async (state: typeof MessagesAnnotation.State) => {
  const { messages } = state;
  const modelWithTools = model.bindTools(tools); // 将工具绑定到模型
  const responseMessage = await modelWithTools.invoke([
    {
      role: "system",
      content: "你是一个个人助理。存储用户告诉你的任何偏好。"
    },
    ...messages
  ]);
  return { messages: [responseMessage] };
};

// 构建工作流
const workflow = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel) // 添加代理节点
  .addNode("tools", new ToolNode(tools)) // 添加工具节点
  .addEdge(START, "agent") // 从开始到代理
  .addConditionalEdges("agent", routeMessage) // 代理根据路由函数决定下一步
  .addEdge("tools", "agent"); // 工具执行后返回代理

// 编译图，并设置检查点（用于持久化和恢复状态）
const memory = new MemorySaver();
const store = new InMemoryStore();
const graph = workflow.compile({ checkpointer: memory, store: store });
```

### 代理交接和网络图入口点

LangGraph 允许你定义复杂的代理交接逻辑，例如在不同专业代理之间切换：

```typescript
const callHotelAdvisor = task("callHotelAdvisor", async (messages: BaseMessageLike[]) => {
  const response = await hotelAdvisor.invoke({ messages });
  return response.messages;
});

const networkGraph = entrypoint(
  "networkGraph",
  async (messages: BaseMessageLike[]) => {
    let currentMessages = addMessages([], messages);
    let callActiveAgent = callTravelAdvisor; // 初始代理

    while (true) {
      const agentMessages = await callActiveAgent(currentMessages);
      currentMessages = addMessages(currentMessages, agentMessages);

      const aiMsg = [...agentMessages].reverse()
        .find((m): m is AIMessage => m.getType() === "ai");

      if (!aiMsg?.tool_calls?.length) {
        break; // 没有工具调用，完成
      }

      const toolCall = aiMsg.tool_calls.at(-1)!;
      if (toolCall.name === "transferToTravelAdvisor") {
        callActiveAgent = callTravelAdvisor; // 切换到旅行顾问
      } else if (toolCall.name === "transferToHotelAdvisor") {
        callActiveAgent = callHotelAdvisor; // 切换到酒店顾问
      } else {
        throw new Error(`Expected transfer tool, got '${toolCall.name}'`);
      }
    }
    return messages;
  });
```

## 持久化和检查点（Checkpoints）

LangGraph 支持通过 `MemorySaver` 或其他检查点实现来持久化图的状态，这对于长时间运行的对话或需要恢复的代理非常有用。

```typescript
import { MemorySaver } from "@langchain/langgraph";

const memory = new MemorySaver();
const graph = workflow.compile({ checkpointer: memory });
```

## 人机协作（Human-in-the-Loop）

LangGraph 允许在工作流中引入人工干预点，例如在代理生成内容后进行人工审核。

```typescript
import { interrupt, Command } from "@langchain/langgraph";

const workflow = entrypoint(
  { checkpointer: new MemorySaver(), name: "workflow" },
  async (topic: string) => {
    const essay = await writeEssay(topic); // 代理生成文章
    const isApproved = interrupt({
      essay, // 需要审核的内容
      action: "请批准/拒绝这篇文章",
    });
    return {
      essay,
      isApproved,
    };
  }
);

// 暂停执行，等待人工输入
for await (const item of await workflow.stream("cat", config)) {
  console.log(item);
}

// 接收人工审核结果并恢复执行
const humanReview = true; // 假设人工批准
for await (const item of await workflow.stream(new Command({ resume: humanReview }), config)) {
  console.log(item);
}
```

## 流式传输（Streaming）

LangGraph 支持流式传输代理的响应，这对于实时交互式应用非常重要。

```typescript
for await (
  const output of await app.stream(inputs, {
    streamMode: "values",
    recursionLimit: 10, // 设置递归限制以防止无限循环
  })
) {
  const lastMessage = output.messages[output.messages.length - 1];
  // 打印消息
  console.log(`[${lastMessage._getType()}]: ${lastMessage.content}`);
}
```

通过这些核心概念和功能，LangGraph.js 提供了一个强大而灵活的框架，用于构建复杂的、有状态的 AI 代理应用程序。
