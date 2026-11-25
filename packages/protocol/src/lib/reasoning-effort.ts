/** 真实请求可用的档位按思考强度排序。default 只用于会话与设置。 */
export const MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export const REASONING_EFFORTS = ["default", ...MODEL_REASONING_EFFORTS] as const;
