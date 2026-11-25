import {
  channelSecretProblem,
  channelSettingsProblems,
  emailAddressProblem,
  NOTIFICATION_SECRET_NAMES,
  storedChannelSecret,
  storedChannelSettings,
  storedEmailAddress,
  type EmailProviderKind,
  type NotificationChannelKind,
  type NotificationChannelSettingsByKind,
  type NotificationChannelView,
} from '@streaming-monorepo/web2-admin-common';

/**
 * A channel's form on the Notifications page as typed, and what it means: the settings and the secret as the API takes
 * them, and every reason they cannot be saved, in the shared package's sentences. One shape serves the three channels;
 * each reads the fields it has.
 */
export interface ChannelDraft {
  provider: EmailProviderKind;
  senderAddress: string;
  senderName: string;
  /** One line per recipient, as typed. */
  recipients: string[];
  chatId: string;
  /** The secret as typed. Empty keeps the stored one. Never filled from the API, which never sends one. */
  secret: string;
}

/** The form of a saved channel, or of one never saved: its settings, an empty secret, and one empty recipient line. */
export function draftOf(channel: NotificationChannelView): ChannelDraft {
  const draft: ChannelDraft = {
    provider: 'brevo',
    senderAddress: '',
    senderName: '',
    recipients: [''],
    chatId: '',
    secret: '',
  };
  if (channel.kind === 'email' && channel.settings) {
    return { ...draft, ...channel.settings, recipients: [...channel.settings.recipients] };
  }
  if (channel.kind === 'telegram' && channel.settings) return { ...draft, chatId: channel.settings.chatId };
  return draft;
}

/** The settings the form holds, as typed. */
export function typedSettings<K extends NotificationChannelKind>(
  kind: K,
  draft: ChannelDraft,
): NotificationChannelSettingsByKind[K];
export function typedSettings(
  kind: NotificationChannelKind,
  draft: ChannelDraft,
): NotificationChannelSettingsByKind[NotificationChannelKind] {
  switch (kind) {
    case 'email':
      return {
        provider: draft.provider,
        senderAddress: draft.senderAddress,
        senderName: draft.senderName,
        recipients: draft.recipients,
      };
    case 'slack':
      return {};
    case 'telegram':
      return { chatId: draft.chatId };
  }
}

/** The secret's name as a sentence says it: "API key", "webhook URL", "bot token". */
export function secretName(kind: NotificationChannelKind): string {
  const name = NOTIFICATION_SECRET_NAMES[kind];
  return /^.[a-z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

/** What a channel never saved says while its secret's field is empty. */
export function secretMissing(kind: NotificationChannelKind): string {
  return `Enter the ${secretName(kind)}.`;
}

/**
 * Every reason the form cannot be saved: the package's `channelSettingsProblems`, and its `channelSecretProblem` for a
 * typed secret. An empty secret keeps the stored one, so it is a problem only for a channel never saved.
 */
export function draftProblems(kind: NotificationChannelKind, draft: ChannelDraft, saved: boolean): string[] {
  const problems = channelSettingsProblems(kind, typedSettings(kind, draft));
  const secret = storedChannelSecret(draft.secret);
  const secretProblem = secret === '' ? (saved ? null : secretMissing(kind)) : channelSecretProblem(kind, secret);
  return secretProblem === null ? problems : [...problems, secretProblem];
}

/** Whether each recipient line is refused: not an address, or one a line above holds already. */
export function recipientLinesRefused(lines: readonly string[]): boolean[] {
  const seen = new Set<string>();
  return lines.map((line) => {
    if (emailAddressProblem(line) !== null) return true;
    const email = storedEmailAddress(line);
    const twice = seen.has(email);
    seen.add(email);
    return twice;
  });
}

/** The request's settings and secret: kept as the API keeps them, and null for an empty secret, which keeps it. */
export function draftRequest<K extends NotificationChannelKind>(
  kind: K,
  draft: ChannelDraft,
): { settings: NotificationChannelSettingsByKind[K]; secret: string | null } {
  const secret = storedChannelSecret(draft.secret);
  return { settings: storedChannelSettings(kind, typedSettings(kind, draft)), secret: secret === '' ? null : secret };
}

/** Whether the form asks for a change: a secret typed, or settings other than the saved ones. */
export function draftChanged(channel: NotificationChannelView, draft: ChannelDraft): boolean {
  const request = draftRequest(channel.kind, draft);
  return request.secret !== null || settingsText(request.settings) !== settingsText(channel.settings);
}

/** Settings as text with their keys in order, so two of one kind compare whatever order the API sent them in. */
function settingsText(settings: object | null): string {
  return settings === null ? '' : JSON.stringify(settings, Object.keys(settings).sort());
}
