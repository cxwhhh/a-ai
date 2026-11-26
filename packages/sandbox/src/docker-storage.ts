import { randomUUID } from "node:crypto";

// 临时文件和可重建缓存共用账号容器原有的 512 MiB tmpfs。容器被回收时，内核会释放整块空间。
export const dockerTemporaryMount = "/tmp:rw,exec,size=512m";
export const dockerScratch = "/tmp/aai-scratch";

// HOME 仍在工作区，保留 Git 配置和显式安装的包。只重定向工具可重建的缓存。
export const dockerCacheEnv = {
  XDG_CACHE_HOME: "/tmp/aai-cache",
  PIP_CACHE_DIR: "/tmp/aai-cache/pip",
  npm_config_cache: "/tmp/aai-cache/npm",
  UV_CACHE_DIR: "/tmp/aai-cache/uv",
  PYTHONPYCACHEPREFIX: "/tmp/aai-cache/pycache",
};

/** 每次调用持有独立临时目录，取消或超时时仍能由容器外的执行器收尾。 */
export function dockerRunStorage(script: string, temporary?: boolean, scoped?: boolean) {
  const directory = `/tmp/aai-run-${randomUUID()}`;
  const pidFile = `${directory}.pid`;
  const cancelled = `${directory}.cancelled`;
  const stop = `if [ -r ${pidFile} ] && read -r pid < ${pidFile} && [[ $pid =~ ^[1-9][0-9]*$ ]]; then kill -KILL -- -"$pid" 2>/dev/null; fi`;

  return {
    script: [
      `echo $$ > ${pidFile} || exit 1`,
      `[ ! -e ${cancelled} ] || exit 130`,
      `mkdir -m 700 -- ${directory} || exit 1`,
      `export TMPDIR=${directory} TMP=${directory} TEMP=${directory}`,
      ...(scoped ? [`mkdir -p -- ${dockerScratch} && cd -- ${dockerScratch} || exit 1`] : temporary ? [`cd -- ${directory} || exit 1`] : []),
      script,
    ].join("\n"),
    // 停止有时早于 Docker 启动 Bash。先写标记，之后启动的进程也能看到取消请求。
    cancel: `: > ${cancelled}\n${stop}`,
    // 用户命令可能有自己的 EXIT trap，或用 exec 替换 shell。执行器只清理本次分配的路径。
    cleanup: `${stop}\nrm -rf -- ${directory} ${pidFile} ${cancelled}`,
  };
}
