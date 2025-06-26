// --- file_path: webview/components/AtCommandMenu.ts ---

// 定义命令节点的接口
interface CommandNode {
    id: string;
    name: string;
    children: (CommandNode | CommandLeaf)[];
}

// 定义命令叶子节点（可执行的Agent）的接口
interface CommandLeaf {
    id: string;
    name: string;
    agentId: string; // 对应 AgentService 中的 ID
    description: string;
}

// 类型守卫，用于判断一个节点是否是叶子节点
function isLeaf(node: CommandNode | CommandLeaf): node is CommandLeaf {
    return !('children' in node);
}

// 所有可用命令的树状结构定义
const COMMAND_TREE: (CommandNode | CommandLeaf)[] = [
    {
        id: 'docgen',
        name: 'DocGen',
        children: [
            {
                id: 'docgen-project',
                name: 'DocGen-Project',
                agentId: 'docgen-project',
                description: '为整个项目生成高级设计文档'
            },
            {
                id: 'docgen-module-direct',
                name: 'DocGen-Module-Direct',
                agentId: 'docgen-module-direct',
                description: '对小模块进行直接、全面的分析'
            },
            {
                id: 'docgen-module-mapreduce',
                name: 'DocGen-Module-MapReduce',
                agentId: 'docgen-module-mapreduce',
                description: '对大模块进行分批摘要总结分析'
            }
        ]
    },
    // 未来可以添加更多一级命令, e.g., CodeRefactor, TestGen etc.
];


export class AtCommandMenu {
    private element: HTMLElement;
    private onSelect: (command: CommandLeaf) => void = () => {};
    
    // 状态管理
    private commands: (CommandNode | CommandLeaf)[] = COMMAND_TREE;
    private currentPath: CommandNode[] = []; // 导航路径
    private visibleItems: (CommandNode | CommandLeaf)[] = []; // 当前显示的列表
    private activeIndex: number = -1; // 当前高亮的索引
    private isSearchMode: boolean = false; // 是否为搜索模式
    private filterText: string = ''; // 搜索文本

    constructor(private container: HTMLElement) {
        // 直接使用传入的容器作为菜单的根元素
        this.element = container;
        this.element.className = 'at-command-menu'; // 确保 class 正确
        this.element.style.display = 'none'; // 默认隐藏

        // 事件监听器直接绑定到容器上
        this.element.addEventListener('click', (e) => {
            const li = (e.target as HTMLElement).closest('li');
            if (li) {
                const index = parseInt(li.dataset.index || '-1', 10);
                if (index !== -1) {
                    this.activeIndex = index;
                    this.handleSelection();
                }
            }
        });
    }

    /**
     * 显示并初始化菜单。
     * @param filter 用户输入的 @ 后面的文本
     * @param onSelect 选择命令后的回调
     */
    public show(filter: string, onSelect: (command: CommandLeaf) => void) {
        this.onSelect = onSelect;
        this.filterText = filter.trim().toLowerCase();
        
        
        // 强制禁用搜索模式，总是显示层级菜单
        this.isSearchMode = false;
        

        this.currentPath = [];
        this.activeIndex = 0;
        
        // 逻辑大幅简化：只需显示并渲染
        this.element.style.display = 'block';
        this.render(); 
    }



    public hide() {
        this.element.style.display = 'none';
        this.currentPath = [];
        this.activeIndex = -1;
    }

    public isVisible(): boolean {
        return this.element.style.display !== 'none';
    }

    /**
     * 处理键盘事件，由 ChatView 委托
     */
    public handleKeyDown(e: KeyboardEvent) {
        if (!this.isVisible()) return;

        e.preventDefault();
        e.stopPropagation();

        switch (e.key) {
            case 'ArrowDown':
                this.activeIndex = (this.activeIndex + 1) % this.visibleItems.length;
                this.render();
                break;
            case 'ArrowUp':
                this.activeIndex = (this.activeIndex - 1 + this.visibleItems.length) % this.visibleItems.length;
                this.render();
                break;
            case 'Tab':
            case 'Enter':
                this.handleSelection();
                break;
            case 'Escape':
                if (this.currentPath.length > 0) {
                    this.currentPath.pop();
                    this.activeIndex = 0;
                    this.render();
                } else {
                    this.hide();
                }
                break;
        }
    }

    /**
     * 处理用户通过 Enter/Tab/Click 进行的选择
     */
    private handleSelection() {
        if (this.activeIndex < 0 || this.activeIndex >= this.visibleItems.length) return;

        const selectedItem = this.visibleItems[this.activeIndex];
        if (isLeaf(selectedItem)) {
            this.onSelect(selectedItem);
            this.hide();
        } else {
            // 进入下一级
            this.currentPath.push(selectedItem);
            this.activeIndex = 0;
            this.render();
        }
    }

    /**
     * 渲染菜单的当前视图
     */
    private render() {
        if (this.isSearchMode) {
            this.renderSearchResults();
        } else {
            this.renderHierarchicalView();
        }
    }

    private renderHierarchicalView() {
        let itemsToShow: (CommandNode | CommandLeaf)[];
        let parent: CommandNode | undefined = this.currentPath[this.currentPath.length - 1];
        
        if (parent) {
            itemsToShow = parent.children;
        } else {
            itemsToShow = this.commands;
        }

        this.visibleItems = itemsToShow;
        if (this.activeIndex >= this.visibleItems.length) {
            this.activeIndex = 0;
        }

        const breadcrumbs = ['@', ...this.currentPath.map(p => p.name)].join(' > ');
        
        this.element.innerHTML = `
            <div class="menu-header">${breadcrumbs}</div>
            <ul>
                ${this.visibleItems.map((item, index) => this.renderItem(item, index)).join('')}
            </ul>
        `;
        this.scrollIntoView();
    }

    private renderSearchResults() {
        const allLeaves = this.flattenCommands(this.commands);
        const searchTerms = this.filterText.split(' ').filter(Boolean);

        this.visibleItems = allLeaves.filter(leaf => 
            searchTerms.every(term => 
                leaf.name.toLowerCase().includes(term) ||
                leaf.agentId.toLowerCase().includes(term) ||
                (this.findPath(leaf.id)?.map(p => p.name.toLowerCase()).join(' ') || '').includes(term)
            )
        );

        if (this.activeIndex >= this.visibleItems.length) {
            this.activeIndex = 0;
        }
        
        if (this.visibleItems.length === 0) {
            this.element.innerHTML = `<div class="menu-header">No results for "${this.filterText}"</div>`;
            return;
        }

        this.element.innerHTML = `
            <div class="menu-header">Search results for "${this.filterText}"</div>
            <ul>
                ${this.visibleItems.map((item, index) => this.renderItem(item, index)).join('')}
            </ul>
        `;
        this.scrollIntoView();
    }

    private renderItem(item: CommandNode | CommandLeaf, index: number): string {
        const isActive = index === this.activeIndex ? 'active' : '';
        const hasChildren = !isLeaf(item);

        return `
            <li class="${isActive}" data-index="${index}">
                <div class="menu-item-name" style="display: flex; align-items: center;">
                    <span>${item.name}</span>
                    ${hasChildren ? '<i class="codicon codicon-chevron-right"></i>' : ''}
                </div>
                ${isLeaf(item) ? `<div class="menu-item-description">${item.description}</div>` : ''}
            </li>
        `;
    }

    private scrollIntoView() {
        const activeItem = this.element.querySelector('li.active');
        if (activeItem) {
            activeItem.scrollIntoView({ block: 'nearest' });
        }
    }

    // --- 辅助函数 ---
    private flattenCommands(nodes: (CommandNode | CommandLeaf)[]): CommandLeaf[] {
        let leaves: CommandLeaf[] = [];
        for (const node of nodes) {
            if (isLeaf(node)) {
                leaves.push(node);
            } else {
                leaves = leaves.concat(this.flattenCommands(node.children));
            }
        }
        return leaves;
    }
    
    private findPath(id: string, nodes: (CommandNode | CommandLeaf)[] = this.commands, path: CommandNode[] = []): CommandNode[] | null {
        for (const node of nodes) {
            if (node.id === id) {
                return path;
            }
            if (!isLeaf(node)) {
                const newPath = [...path, node];
                const found = this.findPath(id, node.children, newPath);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    }
}