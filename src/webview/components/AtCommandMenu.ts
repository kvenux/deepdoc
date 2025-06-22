// --- file_path: webview/components/AtCommandMenu.ts ---

export class AtCommandMenu {
    private element: HTMLElement;
    // 模拟的 Agent 命令列表
    private commands = [
        { id: 'docgen-project', name: '项目级文档生成' },
        { id: 'docgen-module-direct', name: '模块级文档(直接分析)' },
        { id: 'docgen-module-mapreduce', name: '模块级文档(摘要总结)' },
    ];

    constructor(private parent: HTMLElement) {
        this.element = document.createElement('div');
        this.element.className = 'at-command-menu';
        this.element.style.display = 'none';
        this.parent.appendChild(this.element);
    }

    /**
     * 显示并过滤命令菜单
     * @param x 菜单的 x 坐标
     * @param y 菜单的 y 坐标
     * @param filter 用户输入的过滤文本
     * @param onSelect 用户选择命令后的回调函数
     */
    show(x: number, y: number, filter: string, onSelect: (command: any) => void) {
        const filtered = this.commands.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()));
        
        // 如果没有匹配项，则隐藏菜单
        if(filtered.length === 0) {
            this.hide();
            return;
        }

        this.element.innerHTML = `
            <ul>
                ${filtered.map(c => `<li data-id="${c.id}">${c.name}</li>`).join('')}
            </ul>
        `;
        
        // 定位菜单，通常在输入框上方
        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;
        this.element.style.transform = 'translateY(-100%)';
        this.element.style.display = 'block';

        // 为每个列表项添加点击事件监听器
        this.element.querySelectorAll('li').forEach(li => {
            li.addEventListener('click', () => {
                const commandId = li.getAttribute('data-id');
                const command = this.commands.find(c => c.id === commandId);
                if(command) {
                    onSelect(command);
                }
                this.hide();
            });
        });
    }

    /**
     * 隐藏菜单
     */
    hide() {
        this.element.style.display = 'none';
    }

    /**
     * 检查菜单是否可见
     * @returns boolean
     */
    public isVisible(): boolean {
        return this.element.style.display !== 'none';
    }
}