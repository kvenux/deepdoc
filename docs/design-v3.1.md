好的，这正是将前端原型转化为正式功能所需的关键一步。我将为您提供一份详尽的设计文档，包含完整的事件协议、以`ProjectDocumentationOrchestrator`为例的详细流程，以及一个清晰的流程图。

---

## **CodeWiki Agent-Webview 通信协议设计文档**

### **1. 概述**

本文档定义了 CodeWiki 插件后端（Extension Host）与前端（Webview）之间进行 Agent 任务交互的通信协议。该协议旨在实现一个透明、可交互、可观测的 Agent 执行过程。

**设计原则:**

*   **异步事件驱动**: 所有通信均通过异步消息传递，解耦前后端。
*   **状态原子化**: 每个事件都代表一个独立的、原子化的状态变更，便于前端处理。
*   **强类型契约**: 所有事件结构均在 `common/types.ts` 中通过 TypeScript 接口严格定义。
*   **丰富的元数据**: 事件载荷（Payload）包含丰富的元数据（如 `metadata` 字段），用于传递 Token 统计、文件类型等附加信息。

### **2. 核心概念**

*   **`runId` (string)**: 标识一次完整的 Agent 执行过程的唯一ID。所有与单次运行相关的事件都必须包含此 ID。
*   **`taskId` (string)**: 标识一个独立的执行单元（步骤或子任务）的唯一ID。对于并行任务，每个并行分支都有自己独立的 `taskId`。

### **3. 协议规范 (事件接口定义)**

所有事件都遵循 `PostMessage` 接口 (`{ command: string, payload: any }`)。以下是 `payload` 的具体结构定义。

#### **3.1. 前端 -> 后端 (指令)**

| Command | Payload Interface | 描述 |
| :--- | :--- | :--- |
| **`agent:start`** | `AgentStartPayload` | 用户请求启动一个 Agent。 |
| **`agent:cancel`** | `AgentCancelPayload` | 用户请求中止一个正在运行的 Agent。 |
| **`agent:viewFile`** | `ViewFilePayload` | 用户请求在编辑器中查看一个由 Agent 生成的临时文件。 |

```typescript
// in common/types.ts

/**
 * [FE -> BE] 用户请求启动 Agent
 */
export interface AgentStartPayload {
    agentId: string;
    params: Record<string, any>; // 用户输入的参数
}

/**
 * [FE -> BE] 用户请求取消 Agent
 */
export interface AgentCancelPayload {
    runId: string;
}

/**
 * [FE -> BE] 用户请求查看文件
 */
export interface ViewFilePayload {
    path: string; // 文件的临时路径
}
```

#### **3.2. 后端 -> 前端 (通知)**

| Command | Payload Interface | 描述 |
| :--- | :--- | :--- |
| **`agent:planGenerated`** | `AgentPlan` | 通知前端渲染规划视图。 |
| **`agent:stepStart`** | `StepExecution` | 通知前端一个新步骤或子任务已开始。 |
| **`agent:stepUpdate`** | `StepUpdate` | 通知前端步骤执行过程中的日志或中间产物。 |
| **`agent:streamChunk`** | `StreamChunk` | 通知前端 LLM 的流式响应数据块。 |
| **`agent:stepEnd`** | `StepResult` | 通知前端一个步骤或子任务已结束。 |
| **`agent:agentEnd`** | `AgentResult` | 通知前端整个 Agent 任务已结束。 |

```typescript
// in common/types.ts

// --- 核心数据结构 ---

/**
 * Agent 执行计划
 */
export interface AgentPlan {
    agentId: string;
    agentName: string;
    steps: AgentPlanStep[];
    parameters: { name: string; description: string; type: 'path' | 'string'; value?: any; }[];
}

/**
 * Agent 执行计划中的单个步骤
 */
export interface AgentPlanStep {
    name: string;
    description: string;
    promptFiles?: string[]; // 使用的YML/TXT文件名
}

/**
 * [BE -> FE] 一个正在执行的步骤或子任务
 */
export interface StepExecution {
    runId: string;
    stepName: string;
    taskId: string; // 任务的唯一ID，对于主步骤也可以是stepName
    status: 'running' | 'completed' | 'failed' | 'waiting';
}

/**
 * [BE -> FE] 用于更新一个正在执行的步骤的信息
 */
export interface StepUpdate {
    runId: string;
    taskId: string;
    type: 'input' | 'output' | 'llm-request' | 'tool-start' | 'tool-end';
    data: any; // e.g., { name: 'File Tree', content: '...' } 或 { name: 'get_directory_tree', input: {...} }
    metadata?: {
        type?: 'file' | 'markdown';
        path?: string; // 如果是文件，其临时路径
        tokens?: {
            input?: number;
            output?: number;
            total?: number;
        };
    };
}

/**
 * [BE -> FE] 一个 LLM 流式响应的数据块
 */
export interface StreamChunk {
    runId: string;
    taskId: string;
    content: string;
    metadata?: {
        isFinal?: boolean; // 标记是否为最后一块
        tokens?: { output: number; total: number; }; // 在最后一块附上token统计
    };
}

/**
 * [BE -> FE] 一个步骤或子任务的最终结果
 */
export interface StepResult {
    runId: string;
    taskId: string;
    status: 'completed' | 'failed';
    output?: any;
    error?: string;
}

/**
 * [BE -> FE] 整个Agent运行的最终结果
 */
export interface AgentResult {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    finalOutput?: any;
    error?: string;
}
```

---

### **4. `ProjectDocumentationOrchestrator` 流程详解**

以下是该 Agent 从启动到完成的完整事件交互流程。

#### **阶段 1: 启动与规划**

1.  **用户操作**: 在 Webview 中选择 `@Project DocGen` 并回车。
2.  **`[FE -> BE]` `agent:start`**:
    *   `payload`: `{ agentId: 'docgen-project', params: {} }`
3.  **后端响应**: `AgentService` 接收请求，创建 `runId`，并为 `ProjectDocumentationOrchestrator` 生成执行计划。
4.  **`[BE -> FE]` `agent:planGenerated`**:
    *   `payload`: 一个 `AgentPlan` 对象，包含“规划”、“并行分析”、“综合”三个步骤及其提示词。
    *   **UI 响应**: 渲染规划视图，显示步骤卡片和可点击的提示词文件卡片。由于无参数，直接显示“开始执行”按钮。

#### **阶段 2: 规划步骤执行**

1.  **用户操作**: 点击“开始执行”按钮。
2.  **`[BE -> FE]` `agent:stepStart`**:
    *   `payload`: `{ runId, taskId: 'plan_step', stepName: '规划...', status: 'running' }`
    *   **UI 响应**: 规划视图变为只读，下方出现执行视图，并渲染第一个步骤卡片，状态为 `running`。
3.  **`[BE -> FE]` `agent:stepUpdate`**: (LLM 请求)
    *   `payload`: `{ runId, taskId: 'plan_step', type: 'llm-request', data: { name: '规划请求' }, metadata: { path: '...', tokens: { input: 4520 } } }`
    *   **UI 响应**: 在步骤内渲染一个可点击的“规划请求”文件卡片，并显示输入Token。
4.  **`[BE -> FE]` `agent:stepUpdate`**: (LLM 响应)
    *   `payload`: `{ runId, taskId: 'plan_step', type: 'output', data: { name: '规划响应' }, metadata: { path: '...', tokens: { output: 890, total: 5410 } } }`
    *   **UI 响应**: 渲染一个可点击的“规划响应”文件卡片，并显示输出Token。
5.  **`[BE -> FE]` `agent:stepUpdate`**: (Agent 决策)
    *   `payload`: `{ runId, taskId: 'plan_step', type: 'output', data: { name: 'Agent 决策...', content: '[{...}, {...}]' } }`
    *   **UI 响应**: 渲染一个日志卡片，显示 Agent 决策要分析的模块列表。
6.  **`[BE -> FE]` `agent:stepEnd`**:
    *   `payload`: `{ runId, taskId: 'plan_step', status: 'completed' }`
    *   **UI 响应**: “规划”步骤卡片状态变为 `completed`。

#### **阶段 3: 并行分析**

1.  **`[BE -> FE]` `agent:stepStart`**: (父任务)
    *   `payload`: `{ runId, taskId: 'parallel_step', stepName: '执行: 并行分析...', status: 'running' }`
    *   **UI 响应**: 渲染“并行分析”主步骤卡片。
2.  **`[BE -> FE]` 一系列 `agent:stepStart`**: (子任务)
    *   后端根据规划结果，为每个模块（共6个）创建并发送一个 `stepStart` 事件。
    *   `payload`: `{ runId, taskId: 'mod_1', stepName: "分析模块: '核心业务'", status: 'running' }`, `{ runId, taskId: 'mod_2', ... }`
    *   **UI 响应**: 在“并行分析”卡片内部，同时渲染出6个子步骤卡片，状态均为 `running`。
3.  **`[BE -> FE]` 一系列 `toolStart`/`toolEnd`/`stepUpdate`**:
    *   每个子任务会独立地发送自己的工具调用和LLM交互事件，都带有各自的 `taskId` (`mod_1`, `mod_2`, ...)。
    *   **UI 响应**: 前端根据 `taskId`，将这些日志卡片精确地渲染到对应的子步骤卡片内部。
4.  **`[BE -> FE]` 一系列 `agent:stepEnd`**:
    *   当某个模块分析完成，后端发送对应的 `stepEnd` 事件。
    *   `payload`: `{ runId, taskId: 'mod_1', status: 'completed' }`
    *   **UI 响应**: “核心业务”子步骤卡片状态变为 `completed`。其他卡片状态可能不同。
5.  **`[BE -> FE]` `agent:stepEnd`**: (父任务)
    *   当所有子任务都结束后，后端发送父任务的 `stepEnd` 事件。
    *   `payload`: `{ runId, taskId: 'parallel_step', status: 'completed' }`
    *   **UI 响应**: “并行分析”主步骤卡片状态变为 `completed`。

#### **阶段 4 & 5: 综合与结束**

1.  **`[BE -> FE]` `agent:stepStart`**: (综合步骤)
    *   `payload`: `{ runId, taskId: 'synthesis_step', ... }`
2.  **`[BE -> FE]` `agent:streamChunk` (多次)**:
    *   `payload`: `{ runId, taskId: 'synthesis_step', content: '...' }`
    *   **UI 响应**: 在“综合”步骤卡片内流式渲染最终文档。
3.  **`[BE -> FE]` `agent:stepEnd`**: (综合步骤完成)
4.  **`[BE -> FE]` `agent:agentEnd`**:
    *   `payload`: `{ runId, status: 'completed', finalOutput: '项目总体设计文档.md 已生成。' }`
    *   **UI 响应**: 渲染最终的成功结果卡片。

#### **错误处理**
如果阶段3中 `mod_1` 任务失败：
*   后端发送 `agent:stepEnd` `{ taskId: 'mod_1', status: 'failed', error: '...' }`。
*   UI将 `mod_1` 子步骤卡片标红并显示错误。
*   后端逻辑决定是否继续其他并行任务。通常会取消其他任务，并让父任务和整个Agent失败。
*   后端发送 `agent:stepEnd` `{ taskId: 'parallel_step', status: 'failed' }`。
*   后端发送 `agent:agentEnd` `{ runId, status: 'failed', error: '...' }`。
*   UI将主步骤和整个Agent标为失败，并显示最终错误信息。

---

### **5. 流程图 (Sequence Diagram)**

使用 PlantUML 语法描述上述流程：

```plantuml
@startuml
title Agent Execution Protocol Flow

actor "Frontend (Webview)" as FE
participant "Backend (Extension)" as BE

FE -> BE: agent:start (agentId: 'docgen-project')
BE --> FE: agent:planGenerated (plan)

group Planning Phase (User clicks "Start")
    BE --> FE: agent:stepStart (taskId: 'plan_step', status: 'running')
    BE --> FE: agent:stepUpdate (type: 'llm-request', metadata: {tokens: ...})
    BE --> FE: agent:stepUpdate (type: 'output', metadata: {tokens: ...})
    BE --> FE: agent:stepUpdate (type: 'output', data: {content: 'planned modules...'})
    BE --> FE: agent:stepEnd (taskId: 'plan_step', status: 'completed')
end

group Parallel Analysis Phase
    BE --> FE: agent:stepStart (taskId: 'parallel_step', status: 'running')
    
    par
        BE --> FE: agent:stepStart (taskId: 'mod_1', status: 'running')
        BE --> FE: agent:toolStart (taskId: 'mod_1', tool: '...')
        BE --> FE: agent:toolEnd (taskId: 'mod_1', output: '...')
        BE --> FE: agent:stepUpdate (taskId: 'mod_1', type: 'llm-request', ...)
        BE --> FE: agent:stepEnd (taskId: 'mod_1', status: 'completed')
    and
        BE --> FE: agent:stepStart (taskId: 'mod_2', status: 'running')
        ...
        BE --> FE: agent:stepEnd (taskId: 'mod_2', status: 'completed')
    end
    
    BE --> FE: agent:stepEnd (taskId: 'parallel_step', status: 'completed')
end

group Synthesis Phase
    BE --> FE: agent:stepStart (taskId: 'synthesis_step', status: 'running')
    loop Streaming LLM Response
        BE --> FE: agent:streamChunk (content)
    end
    BE --> FE: agent:stepEnd (taskId: 'synthesis_step', status: 'completed')
end

BE --> FE: agent:agentEnd (status: 'completed')

@enduml
```
这张图清晰地展示了前后端的交互时序、并行任务的处理方式以及事件的依赖关系。