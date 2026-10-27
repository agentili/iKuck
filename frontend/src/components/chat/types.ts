export type MessageRole = 'assistant' | 'user' | 'system';

export type MessageType = 'text' | 'recipe' | 'draft' | 'error' | 'typing';

export interface BaseMessage {
  id: string;
  role: MessageRole;
  type: MessageType;
  timestamp: Date;
}

export interface TextMessage extends BaseMessage {
  type: 'text';
  content: string;
}

export interface RecipeData {
  id: string;
  title: string;
  emoji: string;
  time: string;
  servings: number;
  tags: string[];
  image: string;
  description: string;
  ingredients: Array<{ name: string; amount: string }>;
  steps: string[];
  diets: string[];
  allergens: string[];
}

export interface RecipeMessage extends BaseMessage {
  type: 'recipe';
  recipe: RecipeData;
}

export interface DraftMessage extends BaseMessage {
  type: 'draft';
  recipe: RecipeData;
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  content: string;
  recoverable?: boolean;
  action?: { label: string; onAction: () => void };
}

export interface TypingMessage extends BaseMessage {
  type: 'typing';
}

export type ChatMessage = TextMessage | RecipeMessage | DraftMessage | ErrorMessage | TypingMessage;

export interface QuickReply {
  id: string;
  label: string;
  action: 'more' | 'pantry' | 'veg' | 'fast' | 'custom' | 'diary' | 'shopping' | 'house';
  payload?: string;
}

export interface DayData {
  key: 'today' | 'yesterday' | 'dayBefore';
  label: string;
  shortLabel: string;
  recipe: RecipeData;
  alternatives: Array<{
    id: string;
    title: string;
    emoji: string;
    time: string;
    servings: number;
    tags: string[];
    image: string;
  }>;
}