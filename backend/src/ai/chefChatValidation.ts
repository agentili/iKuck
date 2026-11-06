import { z } from 'zod';
import { CHEF_CHAT_HISTORY_MAX_MESSAGES, CHEF_CHAT_INPUT_MAX_LENGTH, CHEF_CHAT_MESSAGE_MAX_LENGTH } from '@ikuck/shared/limits';

const requestSchema = z.object({
  message: z.string().trim().min(1).max(CHEF_CHAT_MESSAGE_MAX_LENGTH),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(CHEF_CHAT_MESSAGE_MAX_LENGTH).refine((value) => value.trim().length > 0) }).strict()).max(CHEF_CHAT_HISTORY_MAX_MESSAGES),
}).strict().refine(({ history }) => history.length % 2 === 0 && history.every((turn, index) => turn.role === (index % 2 === 0 ? 'user' : 'assistant')))
  .refine(({ message, history }) => message.length + history.reduce((total, turn) => total + turn.content.length, 0) <= CHEF_CHAT_INPUT_MAX_LENGTH);

export const parseChefChatRequest = (value: unknown): z.infer<typeof requestSchema> | null => {
  const result = requestSchema.safeParse(value);
  return result.success ? result.data : null;
};
