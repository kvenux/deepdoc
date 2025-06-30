import os
import fnmatch
import argparse
from pathlib import Path

# ==============================================================================
# ---                           CONFIGURATION                            ---
# ==============================================================================
# 在这里配置你的规则，就像在 VS Code 的 settings.json 中一样

# 1. 要包含的文件类型 (使用 glob 模式)
INCLUDE_PATTERNS = [
    '*.py',
    '*.ts',
    '*.tsx',
    '*.js',
    '*.jsx',
    '*.html',
    '*.css',
    '*.scss',
    '*.md',
    '*.yaml',
    '*.yml',
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    '.env.example',
    'requirements.txt',
    'package.json'
]

# 2. 要完全忽略的目录 (无论在多深的路径下，都会被跳过)
EXCLUDE_DIRS = [
    'node_modules',
    '.git',
    '.vscode',
    'dist',
    'build',
    '__pycache__',
    'venv',
    '.venv',
    'target',
    '*.egg-info' # Python 打包产生的目录
]

# 3. 要忽略的特定文件或模式 (使用 glob 模式)
EXCLUDE_FILES = [
    '*.json',
    '*.yml',
    '*.md',
    '*.log',
    '*.lock',
    '*.svg',
    '*.png',
    '*.jpg',
    '*.jpeg',
    '*.gif',
    '*.ico'
]
# ==============================================================================
# ---                        END OF CONFIGURATION                        ---
# ==============================================================================

def find_files(root_dir):
    """根据配置规则查找所有符合条件的文件。"""
    matched_files = []
    for root, dirs, files in os.walk(root_dir, topdown=True):
        # 高效地排除整个目录树
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

        for filename in files:
            file_path = Path(os.path.join(root, filename))
            
            # 检查文件名是否应被排除
            if any(fnmatch.fnmatch(filename, pattern) for pattern in EXCLUDE_FILES):
                continue
            
            # 检查文件类型是否是需要包含的
            if any(fnmatch.fnmatch(filename, pattern) for pattern in INCLUDE_PATTERNS):
                matched_files.append(str(file_path))

    return sorted(matched_files)

def generate_tree_from_list(file_paths, root_dir):
    """根据文件列表生成树形结构字符串。"""
    tree = {}
    for path in file_paths:
        try:
            relative_path = Path(path).relative_to(root_dir)
            parts = relative_path.parts
            current_level = tree
            for part in parts:
                if part not in current_level:
                    current_level[part] = {}
                current_level = current_level[part]
        except ValueError:
            # 当文件不在root_dir下时，可能会发生此错误，尽管逻辑上不应发生
            continue

    def build_tree_string(d, indent=''):
        lines = []
        # 对字典项进行排序，以确保目录总是在文件之前（如果都存在）
        # 并且文件名按字母顺序排列
        sorted_items = sorted(d.items(), key=lambda x: (not bool(x[1]), x[0]))
        for i, (key, value) in enumerate(sorted_items):
            connector = '└── ' if i == len(sorted_items) - 1 else '├── '
            lines.append(f"{indent}{connector}{key}")
            if value:
                extension = '│   ' if i < len(sorted_items) - 1 else '    '
                lines.extend(build_tree_string(value, indent + extension))
        return lines

    tree_str = f"项目结构 (基于过滤规则):\n{os.path.basename(os.path.normpath(root_dir))}\n"
    tree_str += '\n'.join(build_tree_string(tree))
    return tree_str

def main(target_dir, output_file):
    """主函数，执行文件查找、打包和输出。"""
    root_directory = os.path.abspath(target_dir)

    # 验证目标目录是否存在
    if not os.path.isdir(root_directory):
        print(f"❌ 错误: 提供的路径 '{target_dir}' 不是一个有效的目录。")
        return

    print(f"目标目录: {root_directory}")
    print("根据配置规则查找文件...")

    # 1. 查找符合所有规则的文件
    final_files = find_files(root_directory)
    
    if not final_files:
        print("未找到符合条件的文件。请检查您的配置和目标目录。")
        return
        
    print(f"找到 {len(final_files)} 个文件。准备打包...")
    
    # 2. 准备输出内容
    output_content = []
    
    # 2.1 添加文件结构树
    tree_view = generate_tree_from_list(final_files, root_directory)
    output_content.append("=" * 80)
    output_content.append(tree_view)
    output_content.append("=" * 80 + "\n")
    
    # 2.2 添加每个文件的内容
    for file_path in final_files:
        normalized_path = Path(file_path).relative_to(root_directory).as_posix()
        output_content.append(f"--- file_path: {normalized_path} ---")
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                output_content.append(content)
        except Exception as e:
            output_content.append(f"无法读取文件: {e}")
        output_content.append("\n" + "-" * 80 + "\n")
    
    # 3. 将所有内容写入输出文件
    try:
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write("\n".join(output_content))
        print(f"\n✅ 成功！所有内容已打包到: {output_file}")
    except Exception as e:
        print(f"\n❌ 错误：无法写入文件 {output_file}。错误信息: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="根据 VS Code 风格的规则打包指定项目目录的文件到一个单独的文本文件中。",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "-d", "--directory",
        default=".",
        help="要分析的目标项目目录。\n默认: 当前目录"
    )
    parser.add_argument(
        "-o", "--output",
        default="project_context.txt",
        help="输出文件的名称。\n默认: project_context.txt"
    )
    args = parser.parse_args()
    
    main(args.directory, args.output)