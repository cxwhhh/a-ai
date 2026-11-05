import type { NextConfig } from "next";
const c: NextConfig = {
  output: "standalone",
  // pdf.js 不打包进服务端代码，运行时直接从 node_modules 加载（它自己会再加载 worker 文件）
  serverExternalPackages: ["pdfjs-dist"],
  // read_document 运行时按路径读取的字体编码数据，打包追踪不到，要手动带上（Docker 镜像里才有）
  outputFileTracingIncludes: { "/api/chat": ["./node_modules/pdfjs-dist/cmaps/**", "./node_modules/pdfjs-dist/standard_fonts/**"] },
};
export default c;
