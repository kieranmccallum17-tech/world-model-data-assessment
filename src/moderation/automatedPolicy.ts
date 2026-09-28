export type AutomatedDecision =
  | { action: 'allow'; content: string }
  | { action: 'redact'; content: string; reason: string }
  | { action: 'block'; content: ''; reason: string };

const threatPatterns = [
  /\b(?:i(?:'m| am) going to|i will|i'll) (?:kill|hurt|attack) you\b/i,
  /\b(?:bomb threat|plant a bomb|shoot(?:ing)? up)\b/i
];

const credentialPattern = /\b(password|passcode|api[_ -]?key|access[_ -]?token)\s*[:=]\s*([^\s,;]+)/gi;

export function moderateAutomatically(content: string): AutomatedDecision {
  if (threatPatterns.some((pattern) => pattern.test(content))) {
    return { action: 'block', content: '', reason: 'Message blocked by automated safety rules.' };
  }

  const sanitized = content.replace(credentialPattern, (_match, label: string) => `${label}=[REDACTED]`);
  if (sanitized !== content) {
    return { action: 'redact', content: sanitized, reason: 'Sensitive credential-like text was redacted automatically.' };
  }

  return { action: 'allow', content };
}