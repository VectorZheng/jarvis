import { newId } from '../companion/core';
import { askAssistant } from '../recovery/client';
import type { Message } from '../recovery/types';
import type { VoiceSend } from '../voice/controller';

/**
 * 语音闭环的发送端口：一次确认后仅调用一次现有 NDJSON 聊天（askAssistant 三参数接口不变）。
 * 取消信号贯穿上游；未配置后端时 askAssistant 抛出"对话暂时未连接"，交由上层诚实降级为文字，不伪造回复。
 */
export function createChatVoiceSend(): VoiceSend {
  return async (text, { signal }) => {
    const messages: Message[] = [{ id: newId('voice'), role: 'user', content: text }];
    const result = await askAssistant(messages, {}, { signal });
    return { reply: result.reply };
  };
}
