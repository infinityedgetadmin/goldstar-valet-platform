export interface OperatorMessagingConfig {
  messagingServiceSid?: string;
  fromNumber?: string;
}

export interface MessagingProvider {
  send(i: { to: string; body: string; config: OperatorMessagingConfig; statusCallbackUrl?: string }): Promise<{ providerRef: string }>;
  verifyWebhook(i: { url: string; params: Record<string, string>; signature: string; authToken: string }): boolean;
}
