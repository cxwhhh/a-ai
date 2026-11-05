import "server-only";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { db, newId } from "./db";
import { importLegacyData } from "./legacy";
import { DEFAULT_SETTINGS } from "../settings";
import { getSettings, saveSettings } from "./settings";

/**
 * 登录与当前用户。
 *
 * 流程：
 *   注册/登录 → 生成随机 token → 数据库存 token 的哈希 → 浏览器存 token（httpOnly Cookie）
 *   之后每个请求 → 读 Cookie → 算哈希 → 查 auth_tokens 表 → 得到 user_id
 *
 * - 密码用 scrypt 加盐哈希：同样的密码每个人存出来都不一样，而且算一次很慢，很难暴力破解
 * - Cookie 设成 httpOnly：页面里的 JavaScript 读不到，被 XSS 注入脚本也偷不走
 * - SameSite=Lax：别的网站发起的 POST 请求不会带上这个 Cookie，防 CSRF
 */
export interface User {
  id: string;
  username: string;
}

const COOKIE = "a_session";
const TTL_MS = 30 * 86400_000; // 登录有效期 30 天

/* ---------------- 密码 ---------------- */

function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}

function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split("$");
  const a = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b); // 固定时间比较，防止按响应时间猜密码
}

/** 用户不存在时也算一次哈希，让“用户名错”和“密码错”耗时一样，别人无法据此判断用户名是否存在 */
const DUMMY = hashPassword("dummy-password");

/* ---------------- 注册 / 登录 ---------------- */

export const USERNAME_RULE = /^[a-zA-Z0-9_.-]{2,32}$/;

/** 返回新用户，或者一句错误提示 */
export function register(username: string, password: string): User | string {
  if (!USERNAME_RULE.test(username)) return "用户名为 2～32 位字母、数字或 _ . -";
  if (password.length < 8 || password.length > 200) return "密码至少 8 位";
  const first = !db().prepare("SELECT 1 FROM users LIMIT 1").get();
  if (!first && process.env.A_ALLOW_SIGNUP === "0") return "注册已关闭，请联系管理员";
  if (db().prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return "用户名已被使用";

  const user: User = { id: newId("u"), username };
  db().prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
    user.id, username, hashPassword(password), Date.now(),
  );
  // 第一个注册的用户继承升级前 .data 里的旧数据（对话、分组、设置、工作区）
  if (first) importLegacyData(user.id);
  // 显示名默认用用户名（旧设置里没填名字时也一样）
  if (getSettings(user.id).name === DEFAULT_SETTINGS.name) saveSettings(user.id, { name: username });
  return user;
}

/** 简单的防暴力破解：同一用户名连续输错 5 次，锁 1 分钟（内存里记，重启清零） */
const fails = new Map<string, { n: number; until: number }>();

export function login(username: string, password: string): User | string {
  const key = username.toLowerCase();
  const f = fails.get(key);
  if (f && f.until > Date.now()) return "错误次数太多，请 1 分钟后再试";

  const r = db().prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username);
  const ok = verifyPassword(password, r ? (r.password_hash as string) : DUMMY);
  if (!ok || !r) {
    const n = (f?.n ?? 0) + 1;
    fails.set(key, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    return "用户名或密码不对";
  }
  fails.delete(key);
  return { id: r.id as string, username: r.username as string };
}

/* ---------------- 登录状态（Cookie） ---------------- */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** 登录成功后调用：发一个新 token，写进 Cookie */
export async function startLogin(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db().prepare("DELETE FROM auth_tokens WHERE expires_at < ?").run(now); // 顺手清理过期的
  db().prepare("INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, now + TTL_MS);

  // 通过 https 访问时才加 Secure（本机 http://localhost 开发时加了浏览器会不存）
  const h = await headers();
  const https = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: https,
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

/** 当前登录的用户；没登录或已过期返回 null。每个接口第一件事就是调用它 */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const r = db().prepare("SELECT u.id, u.username FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.expires_at > ?")
    .get(sha256(token), Date.now());
  return r ? { id: r.id as string, username: r.username as string } : null;
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) db().prepare("DELETE FROM auth_tokens WHERE token_hash = ?").run(sha256(token));
  jar.delete(COOKIE);
}

/** 没登录时接口统一返回 401，前端收到后跳到登录页 */
export const unauthorized = () => Response.json({ error: "请先登录" }, { status: 401 });
export const notFound = () => Response.json({ error: "not found" }, { status: 404 });
