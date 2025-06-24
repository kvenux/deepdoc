import os
import shutil
import subprocess
import argparse
from datetime import datetime
import re

# --- 配置 ---
DEFAULT_OUTPUT_BASE_DIR = "git_commit_exports_detailed"
GIT_EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904" # Git 的魔法空树哈希

def sanitize_directory_name(name: str, max_length: int = 100) -> str:
    """
    清理字符串，使其成为安全的目录名。
    移除特殊字符，用下划线替换空格，并截断。
    """
    if not name:
        name = "no_message"
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'[\s\-\.]+','_', name) # 将空格、连字符、点替换为下划线
    name = name.strip('_ ')
    return name[:max_length]

def run_git_command(repo_path: str, command: list, decode_output=True, check=True, encoding='utf-8') -> str | bytes:
    """辅助函数，用于运行git命令。"""
    try:
        process = subprocess.run(
            ['git'] + command,
            cwd=repo_path,
            capture_output=True,
            text=decode_output,
            check=check,
            encoding=encoding if decode_output else None,
            errors='ignore' if decode_output else None
        )
        return process.stdout.strip() if decode_output else process.stdout
    except FileNotFoundError:
        print("错误：未找到 'git' 命令。请确保Git已安装并在您的PATH中。")
        raise
    except subprocess.CalledProcessError as e:
        print(f"执行git命令时出错: {' '.join(command)}")
        # 尝试解码stderr，如果失败则显示原始字节串
        stderr_decoded = ""
        if e.stderr:
            if isinstance(e.stderr, bytes):
                try:
                    stderr_decoded = e.stderr.decode(encoding, errors='ignore').strip()
                except:
                    stderr_decoded = str(e.stderr) # Fallback to raw representation
            else:
                stderr_decoded = e.stderr.strip()
        print(f"标准错误输出: {stderr_decoded}")
        raise

def get_git_logs(repo_path: str) -> list:
    """
    获取所有git日志，包含哈希、提交者Unix时间戳和主题。
    按时间顺序返回提交（最旧的在前）。
    """
    log_format = "%H%x00%ct%x00%s%n" # 哈希, 时间戳, 主题
    try:
        log_output = run_git_command(repo_path, ['log', '--reverse', f'--pretty=format:{log_format}'])
    except subprocess.CalledProcessError:
        print(f"错误：无法从 '{repo_path}' 获取git日志。它是一个有效的git仓库吗？")
        return []

    commits = []
    if not log_output:
        return commits

    for line in log_output.strip().split('\n'):
        if not line:
            continue
        try:
            parts = line.split('\x00', 2)
            commit_hash = parts[0]
            committer_timestamp = int(parts[1])
            subject = parts[2].strip()
            if not subject:
                subject = "no_subject"
            commits.append({
                'hash': commit_hash,
                'timestamp': committer_timestamp,
                'message': subject
            })
        except (IndexError, ValueError) as e:
            print(f"警告：无法解析提交行：'{line[:100]}...' - 错误：{e}")
            continue
    return commits

def get_commit_stats(repo_path: str, current_commit_hash: str, prev_commit_hash: str) -> tuple[int, int]:
    """
    获取两个提交之间的统计信息（新增行数，删除行数）。
    """
    insertions = 0
    deletions = 0
    try:
        # --shortstat 只输出最后的统计行
        stat_output = run_git_command(
            repo_path,
            ['diff', '--shortstat', prev_commit_hash, current_commit_hash]
        )
        if stat_output:
            # 示例: "1 file changed, 1 insertion(+), 1 deletion(-)"
            # 或者: "2 files changed, 10 insertions(+)"
            # 或者: "3 files changed, 8 deletions(-)"
            match_insertions = re.search(r'(\d+)\s+insertions?\(\+\)', stat_output)
            if match_insertions:
                insertions = int(match_insertions.group(1))

            match_deletions = re.search(r'(\d+)\s+deletions?\(\-\)', stat_output)
            if match_deletions:
                deletions = int(match_deletions.group(1))
        return insertions, deletions
    except subprocess.CalledProcessError:
        # 如果是第一个提交，与EMPTY_TREE_HASH比较时，如果提交本身就是空的，diff可能会出错
        # 或者其他diff错误，我们假设没有变化
        print(f"  警告：无法获取 {prev_commit_hash}..{current_commit_hash} 的统计信息。可能是一个空提交或初始提交。")
        # 尝试列出当前提交的文件数，如果这是第一个提交
        if prev_commit_hash == GIT_EMPTY_TREE_HASH:
            try:
                ls_tree_output = run_git_command(repo_path, ['ls-tree', '-r', '--name-only', current_commit_hash])
                # 这是一个粗略的估计，我们不能轻易得到行数，但至少知道有文件
                if ls_tree_output and len(ls_tree_output.split('\n')) > 0:
                     print(f"    注意：对于初始提交 {current_commit_hash}，新增行数将显示为0，但文件会被复制。")
                # 无法直接从ls-tree获得新增行数，所以保持为0
            except:
                 pass # 忽略这里的错误
        return 0, 0 # 返回0,0表示无法确定或没有变化


def get_changed_files(repo_path: str, current_commit_hash: str, prev_commit_hash: str) -> list:
    """
    获取 prev_commit_hash 和 current_commit_hash 之间更改的文件。
    对于第一个提交，prev_commit_hash 应为 GIT_EMPTY_TREE_HASH。
    返回相对文件路径列表。
    过滤出新增 (A)、复制 (C)、修改 (M)、重命名 (R)、类型更改 (T) 的文件。
    排除已删除 (D) 的文件。
    """
    try:
        diff_output = run_git_command(
            repo_path,
            ['diff', '--name-status', '--diff-filter=ACMRT', prev_commit_hash, current_commit_hash]
        )
    except subprocess.CalledProcessError as e:
        if "bad revision" in str(e.stderr).lower() and prev_commit_hash == GIT_EMPTY_TREE_HASH:
            print(f"  警告：与空树的diff失败，尝试ls-tree获取初始提交 {current_commit_hash} 的文件。")
            try:
                ls_tree_output = run_git_command(repo_path, ['ls-tree', '-r', '--name-only', current_commit_hash])
                return [f"A\t{fname}" for fname in ls_tree_output.split('\n') if fname] # 模拟diff输出
            except subprocess.CalledProcessError as e_ls:
                print(f"  错误：ls-tree也失败了 {current_commit_hash}: {e_ls}")
                return []
        else:
            print(f"  警告：无法获取 {prev_commit_hash}..{current_commit_hash} 的diff。可能是一个空提交。")
        return []

    changed_files_paths = []
    if not diff_output:
        return changed_files_paths

    for line in diff_output.split('\n'):
        if not line:
            continue
        parts = line.split('\t')
        status = parts[0].strip()
        if status.startswith('R') or status.startswith('C'): # 重命名或复制
            if len(parts) == 3:
                changed_files_paths.append(parts[2].strip()) # 新路径
            else:
                print(f"  警告：无法解析重命名/复制行：'{line}'")
        elif status in ['A', 'M', 'T']: # 新增、修改、类型改变
            if len(parts) == 2:
                changed_files_paths.append(parts[1].strip())
            else:
                print(f"  警告：无法解析 A/M/T 行：'{line}'")
    return changed_files_paths

def copy_file_from_commit(repo_path: str, commit_hash: str, relative_file_path: str, destination_path: str):
    """
    从特定提交复制特定文件到目标路径。
    """
    try:
        file_content_bytes = run_git_command(
            repo_path,
            ['show', f'{commit_hash}:{relative_file_path}'],
            decode_output=False, # 获取原始字节
            check=True
        )
        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        with open(destination_path, 'wb') as f_out:
            f_out.write(file_content_bytes)
    except subprocess.CalledProcessError as e:
        print(f"    警告：无法从提交 '{commit_hash}' 获取 '{relative_file_path}' 的内容。可能是一个子模块或损坏的符号链接。错误详情见git命令输出。")
    except Exception as e:
        print(f"    复制文件 '{relative_file_path}' 到 '{destination_path}' 时出错: {e}")

def main():
    parser = argparse.ArgumentParser(description="从Git仓库为每个提交提取已更改的文件，并在目录名中包含新增行数。")
    parser.add_argument("repo_directory", help="本地Git仓库克隆的路径。")
    parser.add_argument("-o", "--output", help=f"导出文件的基础目录。默认为：./{DEFAULT_OUTPUT_BASE_DIR}", default=DEFAULT_OUTPUT_BASE_DIR)

    args = parser.parse_args()
    repo_path = os.path.abspath(args.repo_directory)
    output_base_path = os.path.abspath(args.output) # 使用用户指定的输出目录

    if not os.path.isdir(os.path.join(repo_path, '.git')):
        print(f"错误：'{repo_path}' 似乎不是一个Git仓库。请检查路径是否正确，以及是否包含'.git'目录。")
        return

    os.makedirs(output_base_path, exist_ok=True)
    print(f"开始从 '{repo_path}' 导出提交更改到 '{output_base_path}'")

    commits = get_git_logs(repo_path)
    if not commits:
        print("未找到提交或获取日志时出错。")
        return

    previous_commit_hash = GIT_EMPTY_TREE_HASH # 对于第一个提交，与空树比较

    for i, commit in enumerate(commits):
        commit_hash = commit['hash']
        timestamp_dt = datetime.fromtimestamp(commit['timestamp'])
        formatted_timestamp = timestamp_dt.strftime("%Y%m%d_%H%M%S")
        sanitized_message = sanitize_directory_name(commit['message'])

        # 获取此提交相对于上一个提交的新增行数和删除行数
        insertions, deletions = get_commit_stats(repo_path, commit_hash, previous_commit_hash)

        # 构造目录名
        # 注意: 对于初始提交，insertions 可能是0，即使有很多文件，因为 `git diff --shortstat EMPTY_TREE HASH`
        # 并不总是能准确给出“新增”行数，它更像是对比。但文件列表会是全量的。
        # 如果需要更精确的初始提交“行数”，可能需要 `git ls-files | xargs wc -l` 之类的，但这超出了diff的范畴。
        # 我们这里就用 diff 的结果。
        dir_suffix = f"新增{insertions}行"
        target_dir_name = f"{formatted_timestamp}_{sanitized_message}_{dir_suffix}"
        target_commit_dir = os.path.join(output_base_path, target_dir_name)

        print(f"\n处理提交 {i+1}/{len(commits)}: {commit_hash[:7]} - {commit['message']}")
        print(f"  统计: 新增 {insertions} 行, 删除 {deletions} 行")
        print(f"  目标目录: {target_dir_name}")

        if os.path.exists(target_commit_dir):
            print(f"  目录 '{target_commit_dir}' 已存在。跳过此提交以避免覆盖。")
            previous_commit_hash = commit_hash # 仍然更新，以便下一个提交能正确比较
            continue

        os.makedirs(target_commit_dir, exist_ok=True)

        changed_files_relative = get_changed_files(repo_path, commit_hash, previous_commit_hash)

        if not changed_files_relative:
            if insertions == 0 and deletions == 0:
                 print("  此提交没有文件更改或代码行数变动 (可能是空提交或仅元数据更改)。")
            else:
                 print("  此提交的代码行数统计有变动，但没有文件符合复制条件 (例如，仅删除了文件)。")

        else:
            print(f"  找到 {len(changed_files_relative)} 个已更改（新增/修改/重命名）的文件:")
            for rel_file_path in changed_files_relative:
                destination_file_path = os.path.join(target_commit_dir, rel_file_path)
                print(f"    - {rel_file_path}")
                copy_file_from_commit(repo_path, commit_hash, rel_file_path, destination_file_path)

        previous_commit_hash = commit_hash # 为下一次迭代更新

    print(f"\n提取完成。文件已导出到 '{output_base_path}'。")

if __name__ == "__main__":
    main()