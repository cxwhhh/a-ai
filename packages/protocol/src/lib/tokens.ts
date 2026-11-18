/**
 * 粗略估算 token 数（前后端共用）。
 * 规律：中日韩字符约 1 字 ≈ 1 token；英文等约 4 个字符 ≈ 1 token。
 * 只用于“没有真实数据时”的估算和占比拆分；真实用量以 API 返回的 usage 为准。
 */
export function estimateTokens(s: string) {
  const cjk = (s.match(/[　-鿿＀-￯]/g) ?? []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}
