// src/extension/agents/AgentContext.ts (修改后完整文件)

import * as vscode from 'vscode'; // <-- 新增 import
import { ModelConfig } from '../../common/types';
import { LLMService } from '../services/LLMService';
import { AgentLogger } from '../services/logging';
import { ToolRegistry } from '../services/ToolRegistry';

/**
 * 定义了Agent执行时所需的完整上下文。
 * 这个对象会作为依赖注入容器，在Agent的各个组件之间传递。
 */
export interface AgentContext {
    llmService: LLMService;
    toolRegistry: ToolRegistry;
    logger: AgentLogger;
    modelConfig: ModelConfig;
    
    // --- 新增 ---
    // 可选的运行目录，用于记录详细的过程文件。
    // 如果提供了这个目录，执行器等组件可以将其中间产物写入文件。
    runDir?: vscode.Uri; 
}