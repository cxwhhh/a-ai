/** 根据 GFM 列表项在源文本中的位置，定位 `[ ]` 或 `[x]` 中间的字符。 */
export function markdownTaskMarker(text: string, itemStart: number): number | undefined {
  if (!Number.isSafeInteger(itemStart) || itemStart < 0) return undefined;
  const start = /^((?:[-+*]|\d{1,9}[.)])[ \t]+)\[[ xX]\](?=[ \t\r\n]|$)/.exec(text.slice(itemStart));
  if (start) return itemStart + start[1].length + 1;
}
