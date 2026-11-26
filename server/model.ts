import OpenAI from "openai";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  // 超时和重试都收紧：模型卡住时，页面不该跟着卡几分钟。
  return new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com",
    timeout: 30_000,
    maxRetries: 1,
  });
}
