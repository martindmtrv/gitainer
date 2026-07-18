export enum WebhookEventType {
  GIT_PUSH = "Git Push",
  ENV_UPDATE = "Env Update",
  WEBHOOK = "Webhook",
}

export function webhookTitle(event: WebhookEventType): string {
  return `Gitainer: ${event}`;
}
