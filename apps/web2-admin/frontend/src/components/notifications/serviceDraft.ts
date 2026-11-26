import {
  NOTICE_SERVICE_SECRET_NAMES,
  serviceSecretProblem,
  serviceSettingsProblems,
  storedServiceSettings,
  type EmailProviderKind,
  type NoticeServiceKind,
  type NoticeServiceSettingsByKind,
  type NoticeServiceView,
} from '@streaming-monorepo/web2-admin-common';

/**
 * A service's form on the Notifications page as typed, and what it means: the settings and the secret as the API takes
 * them, and every reason they cannot be saved, in the shared package's sentences. The email service reads every field;
 * the Telegram service, whose settings are none, reads the secret alone.
 */
export interface ServiceDraft {
  provider: EmailProviderKind;
  senderAddress: string;
  senderName: string;
  /** The secret as typed. Empty keeps the stored one. Never filled from the API, which never sends one. */
  secret: string;
}

/** The form of a saved service, or of one never saved: its settings and an empty secret. */
export function serviceDraftOf(service: NoticeServiceView): ServiceDraft {
  const draft: ServiceDraft = { provider: 'brevo', senderAddress: '', senderName: '', secret: '' };
  if (service.kind === 'email' && service.settings) {
    const { provider, senderAddress, senderName } = service.settings;
    return { ...draft, provider, senderAddress, senderName };
  }
  return draft;
}

/** The settings the form holds, as typed. */
export function typedServiceSettings<K extends NoticeServiceKind>(
  kind: K,
  draft: ServiceDraft,
): NoticeServiceSettingsByKind[K];
export function typedServiceSettings(
  kind: NoticeServiceKind,
  draft: ServiceDraft,
): NoticeServiceSettingsByKind[NoticeServiceKind] {
  return kind === 'email'
    ? { provider: draft.provider, senderAddress: draft.senderAddress, senderName: draft.senderName }
    : {};
}

/** The secret's name as a sentence says it: "API key", "bot token". */
export function secretName(kind: NoticeServiceKind): string {
  const name = NOTICE_SERVICE_SECRET_NAMES[kind];
  return /^.[a-z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

/**
 * Every reason the form cannot be saved: the package's `serviceSettingsProblems`, and its `serviceSecretProblem` for a
 * typed secret. An empty secret keeps the stored one, so it is a problem only for a service never saved.
 */
export function serviceDraftProblems(kind: NoticeServiceKind, draft: ServiceDraft, saved: boolean): string[] {
  const problems = serviceSettingsProblems(kind, typedServiceSettings(kind, draft));
  const secret = draft.secret.trim();
  const secretProblem =
    secret === '' ? (saved ? null : `Enter the ${secretName(kind)}.`) : serviceSecretProblem(kind, secret);
  return secretProblem === null ? problems : [...problems, secretProblem];
}

/** The request's settings and secret: kept as the API keeps them, and null for an empty secret, which keeps it. */
export function serviceDraftRequest<K extends NoticeServiceKind>(
  kind: K,
  draft: ServiceDraft,
): { settings: NoticeServiceSettingsByKind[K]; secret: string | null } {
  const secret = draft.secret.trim();
  return {
    settings: storedServiceSettings(kind, typedServiceSettings(kind, draft)),
    secret: secret === '' ? null : secret,
  };
}

/** Whether the form asks for a change: a secret typed, or settings other than the saved ones. */
export function serviceDraftChanged(service: NoticeServiceView, draft: ServiceDraft): boolean {
  const request = serviceDraftRequest(service.kind, draft);
  return request.secret !== null || settingsText(request.settings) !== settingsText(service.settings);
}

/** Settings as text with their keys in order, so two of one kind compare whatever order the API sent them in. */
function settingsText(settings: object | null): string {
  return settings === null ? '' : JSON.stringify(settings, Object.keys(settings).sort());
}
