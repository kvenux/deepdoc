const fs = require('fs').promises;
const path = require('path');

async function copyAssets() {
  try {
    // 目标目录
    const distDir = path.resolve(__dirname, '../dist');
    await fs.mkdir(distDir, { recursive: true });

    // 找到 tiktoken 的 wasm 文件
    const wasmSourcePath = require.resolve('tiktoken/tiktoken_bg.wasm');
    const wasmFileName = path.basename(wasmSourcePath);
    const wasmDestPath = path.join(distDir, wasmFileName);
    
    // 复制文件
    await fs.copyFile(wasmSourcePath, wasmDestPath);
    console.log(`Copied ${wasmFileName} to dist/`);

  } catch (error) {
    console.error('Error copying assets:', error);
    process.exit(1);
  }
}

copyAssets();