import { vscode } from '../vscode';
import { ChatView } from './ChatView';
import { SettingsView } from './SettingsView';
import { WelcomeView } from './WelcomeView';
import { ChatHistoryView } from './ChatHistoryView';
import { FocusEditorView } from './FocusEditorView';
import { PerformanceSettingsView } from './PerformanceSettingsView';

export class App {
    private chatView: ChatView;
    private focusEditorView?: FocusEditorView;
    private settingsView: SettingsView;
    private welcomeView: WelcomeView;
    private chatHistoryView: ChatHistoryView;
    private performanceSettingsView: PerformanceSettingsView;


    constructor(private readonly parent: HTMLElement) {
        this.parent.innerHTML = this.render();

        this.welcomeView = new WelcomeView(this.parent.querySelector('#view-welcome') as HTMLElement);
        this.chatView = new ChatView(this.parent.querySelector('#view-chat') as HTMLElement);
        this.chatHistoryView = new ChatHistoryView(
            this.parent.querySelector('#view-history') as HTMLElement,
            this.navigateTo.bind(this)
        );
        this.settingsView = new SettingsView(this.parent.querySelector('#view-settings') as HTMLElement);
        this.performanceSettingsView = new PerformanceSettingsView(this.parent.querySelector('#view-performance-settings') as HTMLElement);
    }

    public initialize() {
        this.setupEventListeners();
        // On initial load, determine if this is a focus editor or main view
        if (document.body.classList.contains('focus-editor-body')) {
            vscode.postMessage({ command: 'ready' });
        } else {
            this.navigateTo('chat');
            vscode.postMessage({ command: 'ready' });
        }
    }

    private setupEventListeners() {
        // Top toolbar navigation
        this.parent.querySelector('#nav-new-chat')?.addEventListener('click', () => this.chatView.clearChat());
        this.parent.querySelector('#nav-chat')?.addEventListener('click', () => this.navigateTo('chat'));
        this.parent.querySelector('#nav-history')?.addEventListener('click', () => this.navigateTo('history'));
        this.parent.querySelector('#nav-prompts')?.addEventListener('click', () => this.navigateTo('prompts'));
        this.parent.querySelector('#nav-settings')?.addEventListener('click', () => this.navigateTo('settings'));
        this.parent.querySelector('#nav-performance-settings')?.addEventListener('click', () => this.navigateTo('performance-settings'));

        // Listen for messages from the extension host
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'initialize':
                    this.chatView.setConversations(message.payload.conversations);
                    this.chatHistoryView.setConversations(message.payload.conversations);
                    // this.promptManagerView.update(message.payload.prompts);
                    // this.chatView.setPrompts(message.payload.prompts);
                    this.chatView.setModelConfigs(message.payload.modelConfigs);
                    this.settingsView.setModelConfigs(message.payload.modelConfigs);
                    if (message.payload.performanceConfig) {
                        this.performanceSettingsView.setPerformanceConfig(message.payload.performanceConfig);
                    }
                    break;
                case 'setActiveConversation':
                    this.chatView.loadConversation(message.payload);
                    break;
                case 'updateModelConfigs':
                    this.chatView.setModelConfigs(message.payload);
                    this.settingsView.setModelConfigs(message.payload);
                    if (this.focusEditorView) {
                        this.focusEditorView.setModelConfigs(message.payload);
                    }
                    break;
                case 'updateHistory':
                    this.chatHistoryView.setConversations(message.payload);
                    break;
                case 'showFocusEditor':
                    this.navigateTo('focus-editor', message.payload);
                    break;
                case 'updateContent':
                    if (this.focusEditorView) {
                        this.focusEditorView.updateContent(message.payload.content);
                    }
                    const mainTextarea = this.chatView['bottomPanel'].querySelector('textarea');
                    if (mainTextarea && mainTextarea.value !== message.payload.content) {
                        mainTextarea.value = message.payload.content;
                        this.chatView['autoResizeInput'](mainTextarea);
                    }
                    break;
                case 'updateState':
                    if (this.focusEditorView) {
                        this.focusEditorView.updateState(message.payload);
                    }
                    if (message.payload.modelId) {
                        this.chatView['modelSelector'].value = message.payload.modelId;
                    }
                    if (message.payload.promptId) {
                        this.chatView['promptSelector'].value = message.payload.promptId;
                    }
                    break;
                case 'clearInput':
                    const textarea = this.chatView['bottomPanel'].querySelector('textarea');
                    if (textarea) {
                        textarea.value = '';
                        this.chatView['autoResizeInput'](textarea);
                    }
                    if (this.focusEditorView) {
                        this.focusEditorView.clearInput();
                    }
                    break;
                case 'focusEditorClosed':
                    this.navigateTo('chat');
                    const topToolbar = this.parent.querySelector('.top-toolbar') as HTMLElement;
                    if (topToolbar) topToolbar.style.display = 'flex';
                    this.chatView['toggleMaximizeButton'](false);
                    break;
            }
        });
    }

    public navigateTo(view: string, data?: any) {
        this.parent.querySelectorAll('.view').forEach(v => {
            (v as HTMLElement).style.display = 'none';
        });

        let activeNav = view;

        if (view === 'performance-settings') {
            activeNav = 'performance-settings';
        } else if (view === 'settings') {
            activeNav = 'settings';
        }

        if (view === 'chat' && typeof data === 'string') {
            vscode.postMessage({ command: 'loadConversation', payload: { id: data } });
        } else if (view === 'focus-editor') {
            const container = this.parent.querySelector('#view-focus-editor') as HTMLElement;
            if (!this.focusEditorView) {
                this.focusEditorView = new FocusEditorView(container, data);
            }

            // 直接从 data payload 中获取数据并设置
            if (data.modelConfigs) {
                this.focusEditorView.setModelConfigs(data.modelConfigs);
            }
            if (data.prompts) {
                this.focusEditorView.setPrompts(data.prompts);
            }

            // 每次导航时都更新内容和状态
            this.focusEditorView.updateContent(data.content);
            this.focusEditorView.updateState(data);
            container.style.display = 'flex';
            const topToolbar = this.parent.querySelector('.top-toolbar') as HTMLElement;
            if (topToolbar) topToolbar.style.display = 'none';
            return; // Skip nav update for focus editor
        }

        // 找到目标视图并显示它
        const targetView = this.parent.querySelector(`#view-${view}`);
        if (targetView) {
            // --- 确保这里是 'flex' ---
            (targetView as HTMLElement).style.display = 'flex';
        } else {
            // 如果找不到视图，打印一个错误，这有助于调试
            console.error(`NavigateTo: Could not find view with id #view-${view}`);
        }

        // 更新顶部导航栏图标的激活状态
        this.parent.querySelectorAll('.nav-icon').forEach(icon => icon.classList.remove('active'));
        const navIcon = this.parent.querySelector(`#nav-${activeNav}`);
        if (navIcon) {
            navIcon.classList.add('active');
        } else {
            console.error(`NavigateTo: Could not find nav icon with id #nav-${activeNav}`);
        }
    }

    private render(): string {
        // 更新工具栏 HTML
        return `
            <div class="top-toolbar">
                <div id="nav-new-chat" class="nav-icon" title="New Chat"><i class="codicon codicon-add"></i></div>
                <div class="nav-separator"></div>
                <div id="nav-chat" class="nav-icon" title="Chat"><i class="codicon codicon-comment-discussion"></i></div>
                <div id="nav-history" class="nav-icon" title="History"><i class="codicon codicon-history"></i></div>
                <!-- <div id="nav-prompts" class="nav-icon" title="Prompts"><i class="codicon codicon-symbol-keyword"></i></div> -->
                <div id="nav-settings" class="nav-icon" title="Model Settings"><i class="codicon codicon-server-environment"></i></div>
                <div id="nav-performance-settings" class="nav-icon" title="Performance Settings"><i class="codicon codicon-settings-gear"></i></div>
            </div>
            <div class="main-content">
                <div id="view-welcome" class="view"></div>
                <div id="view-chat" class="view"></div>
                <div id="view-history" class="view"></div>
                <!-- <div id="view-prompts" class="view"></div> -->
                <!-- <div id="view-prompt-editor" class="view"></div> -->
                <div id="view-settings" class="view"></div>
                <div id="view-performance-settings" class="view"></div>
                <div id="view-focus-editor" class="view"></div>
            </div>
        `;
    }
}
