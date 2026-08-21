/**
 * Copied verbatim from web-agent-codex-runtime/src/providers/selectorManifest.ts
 * (battle-tested against the real ChatGPT / DeepSeek / GLM DOM, including the
 * 2026-08 GLM "思考结束" terminal-marker and DeepSeek action-row completion
 * contracts). Adjust imports only.
 */

export type ProviderCompletionStrategy = "chatgpt" | "deepseek" | "glm" | "generic";

export interface ProviderCompletionManifest {
  strategy: ProviderCompletionStrategy;
  stopSelector: string;
  continuationText?: string;
  readySelector?: string;
  completionMarkerText?: string;
  answerSelector?: string;
  requiresAnswerActions?: boolean;
  completionActionSelector?: string;
  requiresCompletionAction?: boolean;
}

export interface ProviderSelectorManifest {
  providerId: string;
  composer: string;
  send: string;
  copy: string;
  assistant: string;
  completion?: ProviderCompletionManifest;
}

const COMMON_STOP_SELECTOR = "button[aria-label*='Stop'], button[aria-label*='停止'], [data-testid*='stop'], button[aria-busy='true'], [role='button'][aria-busy='true']";

const providerCompletionManifests: Record<string, ProviderCompletionManifest> = {
  chatgpt: {
    strategy: "chatgpt",
    stopSelector: COMMON_STOP_SELECTOR,
    completionActionSelector: "button[data-testid='copy-turn-action-button'], button[aria-label*='Copy'], button[aria-label*='复制']",
    requiresCompletionAction: true
  },
  deepseek: {
    strategy: "deepseek",
    stopSelector: COMMON_STOP_SELECTOR,
    continuationText: "继续生成|continue generating",
    answerSelector: ".ds-assistant-message-main-content",
    requiresAnswerActions: true
  },
  glm: {
    strategy: "glm",
    stopSelector: COMMON_STOP_SELECTOR,
    readySelector: ".enter.is-main-chat",
    answerSelector: ".answer .answer-content-wrap:not(.text-advance-thinking-content)",
    completionMarkerText: "思考结束|思考完成|生成完成|回答完成|generation complete|completed"
  }
};

export function completionManifestFor(providerId: string): ProviderCompletionManifest {
  return providerCompletionManifests[providerId] ?? {
    strategy: "generic",
    stopSelector: COMMON_STOP_SELECTOR
  };
}

export const providerSelectorManifests: Record<string, ProviderSelectorManifest> = {
  chatgpt: {
    providerId: "chatgpt",
    composer: "[data-testid='prompt-textarea'], #prompt-textarea, form [contenteditable='true'], [aria-label='与 ChatGPT 聊天'], textarea[placeholder*='Message']",
    send: "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送']",
    // Action buttons live in the turn <section>, outside the message node (DOM change
    // observed 2026-08-21). .last() in copyLatestAnswer picks the newest turn's button.
    copy: "[data-testid^='conversation-turn-'] button[data-testid='copy-turn-action-button'], [data-testid^='conversation-turn-'] button[aria-label*='Copy'], [data-testid^='conversation-turn-'] button[aria-label*='复制']",
    assistant: "[data-testid^='conversation-turn-'][data-turn='assistant'], [data-message-author-role='assistant']",
    completion: providerCompletionManifests.chatgpt
  },
  deepseek: {
    providerId: "deepseek",
    composer: "textarea[placeholder*='DeepSeek'], textarea, [contenteditable='true']",
    send: "button[aria-label*='Send'], button[aria-label*='发送'], button[class*='send'], div.ds-button--primary.ds-button--filled.ds-button--circle",
    copy: ".ds-message + .ds-flex > .ds-flex:first-child > .ds-button[role='button']:first-child",
    assistant: ".ds-assistant-message-main-content",
    completion: providerCompletionManifests.deepseek
  },
  glm: {
    providerId: "glm",
    composer: "textarea, [contenteditable='true']",
    send: ".enter.is-main-chat, button[aria-label*='Send'], button[aria-label*='发送'], button[class*='send']",
    // Code blocks expose a header "复制" button (div.copy-button) that yields clean
    // plain text; the sibling "复制 markdown" button yields GLM's own markdown
    // rendering, which mangles quotes/line breaks (2026-08-19 incident). Prefer the
    // plain button explicitly; if no copy control is clickable, copyLatestAnswer
    // falls back to DOM text, which is acceptable for prose but lossy for code.
    copy: ".answer div.copy-button:not(:has-text('markdown')), .answer .interact-container .copy, .answer button[aria-label*='Copy']:not(:has-text('markdown')), .answer button[aria-label*='复制']:not(:has-text('markdown'))",
    assistant: ".answer .answer-content-wrap:not(.text-advance-thinking-content)",
    completion: providerCompletionManifests.glm
  }
};
