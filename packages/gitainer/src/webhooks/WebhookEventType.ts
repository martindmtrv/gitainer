export enum WebhookEventType {
  GIT_PUSH = "Git Push",
  ENV_UPDATE = "Env Update",
  WEBHOOK = "Webhook",
  // a stack action started from the manager UI rather than by another API client
  UI = "UI",
}

export function webhookTitle(event: WebhookEventType): string {
  return `Gitainer: ${event}`;
}
