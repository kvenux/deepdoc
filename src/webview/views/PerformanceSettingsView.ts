// --- file_path: webview/views/PerformanceSettingsView.ts ---
import { PerformanceConfig } from "../../common/types";
import { vscode } from "../vscode";

export class PerformanceSettingsView {
    private config: PerformanceConfig | null = null;

    constructor(private readonly parent: HTMLElement) {
        // 初始渲染为空，等待数据
        this.parent.innerHTML = '';
        this.setupEventListeners();
    }

    public setPerformanceConfig(config: PerformanceConfig) {
        this.config = config;
        this.render();
    }

    private setupEventListeners() {
        this.parent.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const button = target.closest('button');
            if (!button || !button.matches('.btn-save-perf')) return;

            this.saveConfig();
        });
    }

    private saveConfig() {
        const form = this.parent.querySelector('#perf-config-form') as HTMLFormElement;
        if (!form || !this.config) return;

        const newConfig: PerformanceConfig = {
            concurrencyLimit: parseInt((form.querySelector('input[name="concurrencyLimit"]') as HTMLInputElement).value, 10) || this.config.concurrencyLimit,
            minInterval: parseInt((form.querySelector('input[name="minInterval"]') as HTMLInputElement).value, 10) || this.config.minInterval,
            maxTokensPerBatch: parseInt((form.querySelector('input[name="maxTokensPerBatch"]') as HTMLInputElement).value, 10) || this.config.maxTokensPerBatch,
            maxTokensForDirectAnalysis: parseInt((form.querySelector('input[name="maxTokensForDirectAnalysis"]') as HTMLInputElement).value, 10) || this.config.maxTokensForDirectAnalysis,
        };

        vscode.postMessage({ command: 'savePerformanceConfig', payload: newConfig });
        vscode.postMessage({ command: 'info', payload: 'Performance settings saved.' });
    }

    private render() {
        if (!this.config) {
            this.parent.innerHTML = `<p>Loading performance settings...</p>`;
            return;
        }

        this.parent.innerHTML = `
            <div class="settings-container">
                <div class="view-header">
                    <h2>性能与限制设置</h2>
                </div>
                <form class="config-form" id="perf-config-form">
                    <div class="form-group">
                        <label for="concurrencyLimit">LLM 最大并发请求数</label>
                        <input type="number" id="concurrencyLimit" name="concurrencyLimit" value="${this.config.concurrencyLimit}">
                        <div class="form-group-description">同时向语言模型发送的最大请求数量。较低的值可以避免超出 API 速率限制。</div>
                    </div>
                    <div class="form-group">
                        <label for="minInterval">LLM 请求最小间隔 (毫秒)</label>
                        <input type="number" id="minInterval" name="minInterval" value="${this.config.minInterval}">
                        <div class="form-group-description">两次连续的 LLM 请求之间的最小时间间隔，用于控制请求频率。</div>
                    </div>
                    <div class="form-group">
                        <label for="maxTokensPerBatch">Map-Reduce 每批最大 Token 数</label>
                        <input type="number" id="maxTokensPerBatch" name="maxTokensPerBatch" value="${this.config.maxTokensPerBatch}">
                        <div class="form-group-description">在使用 Map-Reduce 策略分析大模块时，每个批次包含的最大 Token 数量。</div>
                    </div>
                    <div class="form-group">
                        <label for="maxTokensForDirectAnalysis">直接分析最大 Token 阈值</label>
                        <input type="number" id="maxTokensForDirectAnalysis" name="maxTokensForDirectAnalysis" value="${this.config.maxTokensForDirectAnalysis}">
                        <div class="form-group-description">当模块总 Token 数低于此值时，将使用直接分析策略，否则切换到 Map-Reduce。</div>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn-save-perf">保存设置</button>
                    </div>
                </form>
            </div>
        `;
    }
}