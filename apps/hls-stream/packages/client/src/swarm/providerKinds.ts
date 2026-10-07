/** Every kind of provider this build carries. A setting naming another kind is refused. */
export const PROVIDER_KINDS = ['bee-http'] as const;

export type ProviderKindName = (typeof PROVIDER_KINDS)[number];
