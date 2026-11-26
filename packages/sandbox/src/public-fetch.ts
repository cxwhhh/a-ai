import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export class PrivateAddressError extends Error {}

/** URL 会把 IPv4-mapped IPv6 规范化为两个十六进制组，统一转回 IPv4 再判断。 */
export function isPrivateHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const type = isIP(value);
  if (type === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113);
  }
  if (type === 6) {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return isPrivateHost([high >> 8, high & 255, low >> 8, low & 255].join("."));
    }
    // 只接受全球单播地址，排除文档、隧道和特殊用途网段。
    return !/^[23]/.test(canonical) || /^(?:2001:(?:0|db8):|2001::|2002:|3fff:)/.test(canonical);
  }
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal");
}

async function publicAddresses(host: string) {
  if (isPrivateHost(host)) throw new PrivateAddressError("不允许访问本机或内网地址");
  const addresses = await lookup(host, { all: true }).catch(() => {
    throw new Error(`域名解析失败：${host}`);
  });
  if (!addresses.length || addresses.some(({ address }) => !isIP(address) || isPrivateHost(address))) {
    throw new PrivateAddressError("不允许访问本机或内网地址（域名解析到了受限地址）");
  }
  return addresses;
}

const lookupPublic: LookupFunction = (host, options, done) => {
  // 传给套接字的是刚检查过的地址，避免两次解析之间改变 DNS 记录。
  void publicAddresses(host).then((addresses) => {
    const matching = options.family ? addresses.filter(({ family }) => family === options.family) : addresses;
    if (!matching.length) return done(new Error("没有符合地址族的公网地址"), "", 0);
    if (options.all) return done(null, matching);
    done(null, matching[0].address, matching[0].family);
  }, (error: Error) => done(error, "", 0));
};
const publicAgent = new Agent({ connect: { lookup: lookupPublic } });

export function httpUrl(input: string | URL) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("只支持不含用户名和密码的 HTTP 或 HTTPS 地址");
  }
  return url;
}

/** 每跳调用时先验目标，同时把实际建连限制在通过同一策略检查的地址。 */
export async function fetchPublic(url: URL, init: RequestInit, request?: Request) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateHost(host)) throw new PrivateAddressError("不允许访问本机或内网地址");
  } else {
    await publicAddresses(host);
  }
  const options = { ...init, dispatcher: publicAgent };
  return fetch(request ?? url, options);
}

const TEXT_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 按解压后的实际字节计数，chunked 和压缩响应也受同一上限约束。 */
export async function readBoundedText(res: Response, maxBytes = TEXT_RESPONSE_BYTES) {
  if (!res.body) return "";
  const headers = res.headers;
  if (!headers.has("content-encoding") && Number(headers.get("content-length")) > maxBytes) {
    await res.body.cancel();
    throw new Error(`响应正文超过 ${maxBytes} 字节`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`响应正文超过 ${maxBytes} 字节`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
