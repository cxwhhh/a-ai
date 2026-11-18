/** 内容是不是一张 SVG 图（允许前面有 <?xml ?>、注释和 DOCTYPE）。前后端都能用 */
export const isSvg = (text: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text);
