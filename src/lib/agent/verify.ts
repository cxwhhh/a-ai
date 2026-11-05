import type { ToolCall } from "../llm/types";
import type { Feedback, StoredMessage } from "../shared";

/** 自动反馈消息的开头。模型和 mock 都靠它认出“这是 agent 发的，不是用户打的字” */
export const FEEDBACK_TAG = "【A.ai 自动检查】";

const TAIL = 1500;

interface Run {
  ok: boolean;
  /** 报错信息（stderr 末尾 / 超时 / 启动失败） */
  error: string;
  /** 已经因为这次失败发过反馈了：模型看完反馈后选择不再运行，就尊重它的判断 */
  flagged: boolean;
}

/**
 * 反馈闭环的“裁判”：写 → 运行 → 看报错 → 修改，直到运行通过才交付。
 *
 * ReAct 循环本身已经会把工具结果发回模型，但模型可能看到报错后仍然直接说“完成了”，
 * 或者写了代码根本没运行。Verifier 在模型“想交付”（不再调用工具）的那一刻做检查：
 *
 *   最近一次 run_python 失败，或终端里
 *   跑 Python / 测试的命令失败        → 把报错发回去，要求修复后重新运行（retry）
 *   写了或改了 .py 文件 / Python 代码产出，
 *   之后没有成功运行过                → 要求运行验证一次（unverified，只提醒一次）
 *   都没问题                          → 放行，交付给用户
 *
 * 最多 maxRounds 轮，用完就放行：模型最后的回答里要如实说明没通过的部分（提示词里有要求）。
 * 它只看工具调用和结果，不调用模型，也不碰数据库，所以很容易单独测试。
 */
export class Verifier {
  private lastRun: Run | null = null;
  /** 写了但还没验证的代码：path 或标题 → 代码内容 */
  private unverified = new Map<string, string>();
  /** 运行成功过的代码（用来判断产出里的代码是否就是验证过的那份） */
  private passed: string[] = [];
  private nudged = false;
  rounds = 0;

  constructor(readonly maxRounds: number) {}

  /** 每个工具执行完调用一次 */
  observe(call: ToolCall, result: StoredMessage) {
    const args = parseArgs(call.arguments);
    if (call.name === "run_python") {
      const code = String(args.code ?? "");
      const r = result.isError ? null : parseArgs(result.content);
      const ok = !!r && r.exitCode === 0 && !r.timedOut;
      this.lastRun = {
        ok,
        flagged: false,
        error: result.isError
          ? result.content
          : r?.timedOut
            ? "运行超时（超过 20 秒被结束）。检查是否有死循环、等待输入（input()）或太慢的算法。"
            : `退出码 ${r?.exitCode}\n${String(r?.stderr ?? "").slice(-TAIL)}`,
      };
      if (ok) {
        this.passed.push(norm(code));
        // 这次运行的代码就是那份文件 / 产出，或者代码里引用了那个文件名 → 算验证过了
        for (const [key, src] of this.unverified) {
          if (norm(src) === norm(code) || (/\.py$/i.test(key) && code.includes(baseName(key)))) this.unverified.delete(key);
        }
      }
    } else if (call.name === "run_command" && RUNS_CODE.test(String(args.command ?? ""))) {
      // 终端里跑 python xx.py / pytest 也算一次运行（只看这类命令：ls、pip install 失败不是代码的问题）
      const cmd = String(args.command);
      const r = result.isError ? null : parseArgs(result.content);
      if (r?.denied) return; // 用户拒绝执行，不算运行
      const ok = !!r && r.exitCode === 0 && !r.timedOut;
      this.lastRun = {
        ok,
        flagged: false,
        error: result.isError ? result.content : r?.timedOut ? "命令运行超时被结束。检查是否有死循环、等待输入或太慢的步骤。" : `退出码 ${r?.exitCode}\n${String(r?.output ?? "").slice(-TAIL)}`,
      };
      if (ok) for (const key of this.unverified.keys()) if (/\.py$/i.test(key) && cmd.includes(baseName(key))) this.unverified.delete(key);
    } else if (!result.isError && call.name === "write_file" && /\.py$/i.test(String(args.path ?? ""))) {
      this.track(String(args.path), String(args.content ?? ""));
    } else if (!result.isError && call.name === "edit_file" && /\.py$/i.test(String(args.path ?? ""))) {
      // 改过的文件全文不在参数里，内容记成空：只能靠之后“运行了这个文件名”来算验证过
      this.unverified.set(String(args.path), "");
    } else if (!result.isError && call.name === "create_artifact" && args.kind === "code" && /^py(thon)?$/i.test(String(args.language ?? ""))) {
      this.track(String(args.title ?? "代码"), String(args.content ?? ""));
    }
  }

  private track(key: string, content: string) {
    if (this.passed.includes(norm(content))) return; // 先运行通过、再保存同一份代码，不用再验证
    this.unverified.set(key, content);
  }

  /**
   * 模型想交付时调用。返回 null = 放行；否则返回要发回给模型的反馈。
   */
  check(): { content: string; feedback: Feedback } | null {
    if (this.rounds >= this.maxRounds) return null;
    const run = this.lastRun;
    const lastChance = this.rounds + 1 >= this.maxRounds;
    const footer = lastChance
      ? "\n这是最后一次自动修复机会：如果还是无法通过，请在回答里如实说明哪里没通过、原因和建议，不要说“已完成”。"
      : "";

    if (run && !run.ok && !run.flagged) {
      run.flagged = true;
      this.rounds++;
      return {
        feedback: { kind: "retry", round: this.rounds, max: this.maxRounds, summary: `运行失败，已把报错发回模型修复（第 ${this.rounds}/${this.maxRounds} 轮）` },
        content:
          `${FEEDBACK_TAG}最近一次运行代码失败，还不能交付。\n` +
          "```\n" + run.error.trim() + "\n```\n" +
          "请先判断原因（读报错的最后一行和行号），修改代码后再运行（run_python，或用 run_command 运行文件 / 测试），直到通过再回答用户。" +
          "如果这个报错正是用户想要的（例如演示报错），直接说明即可。" +
          footer,
      };
    }

    if (this.unverified.size && !this.nudged) {
      this.nudged = true;
      this.rounds++;
      const names = [...this.unverified.keys()].join("、");
      return {
        feedback: { kind: "unverified", round: this.rounds, max: this.maxRounds, summary: `写了代码但没运行，已要求模型验证：${names}` },
        content:
          `${FEEDBACK_TAG}你写了 Python 代码（${names}），但还没有运行验证过。` +
          "请用 run_python 或 run_command 实际运行一次（需要文件就读工作区里的文件；需要用户输入或联网的部分，用示例数据代替），确认没有报错再回答。" +
          "如果确实无法在这里运行（例如需要图形界面、硬件或密钥），直接说明原因即可。" +
          footer,
      };
    }
    return null;
  }
}

/** 步数用完时发给模型的话：不能再调用工具，根据已有结果直接总结 */
export function limitFeedback(maxSteps: number): { content: string; feedback: Feedback } {
  return {
    feedback: { kind: "limit", summary: `已达到 ${maxSteps} 步上限，要求模型直接总结` },
    content:
      `${FEEDBACK_TAG}本轮已达到步数上限（${maxSteps} 步），不能再调用工具。` +
      "请根据目前已有的结果直接给出最终回答；没完成或没验证通过的部分要如实说明，并给出下一步建议。",
  };
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** 终端命令里是在运行 Python 代码或测试吗（python x.py、python3 -m pytest、pytest） */
const RUNS_CODE = /\b(python3?|pytest)\b(?!\s+(-V|--version)\b)(?!\s+-m\s+(pip|venv)\b)/;

const norm = (code: string) => code.replace(/\r\n/g, "\n").trim();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
