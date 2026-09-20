import { array, number, object, string } from 'yup';

import { UUID_RE } from './stream.js';

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

const positiveSafeInteger = (name: string) =>
  number()
    .required()
    .integer(`${name} must be a whole number`)
    .min(1, `${name} must be positive`)
    .max(Number.MAX_SAFE_INTEGER, `${name} must be a safe integer`);

const releaseGuardRole = string<'manager' | 'admin' | 'uploader' | 'viewer'>()
  .required()
  .oneOf(['manager', 'admin', 'uploader', 'viewer']);

export const releaseGuardSlotSchema = object({
  role: releaseGuardRole,
  id: string().required().max(200),
})
  .test(
    'role-slot-id',
    'manager, admin, and viewer slot id must be default; uploader slot id must use the safe identity grammar',
    (value) =>
      value === undefined ||
      (value.role === 'uploader'
        ? SAFE_ID_RE.test(value.id ?? '')
        : value.id === 'default'),
  )
  .noUnknown(true);

const releaseGuardImageSchema = object({
  service: string().required().matches(SAFE_ID_RE),
  imageId: string().required().matches(IMAGE_ID_RE),
}).noUnknown(true);

export const releaseGuardArtifactSchema = object({
  treeDigest: string().required().matches(HEX_DIGEST_RE),
  images: array()
    .of(releaseGuardImageSchema.required())
    .required()
    .min(1)
    .max(32)
    .test(
      'sorted-unique-services',
      'artifact images must be sorted and unique by service',
      (value) =>
        value === undefined ||
        value.every(
          ({ service }, index) =>
            index === 0 || (value[index - 1]?.service ?? '') < service,
        ),
    ),
})
  .required()
  .noUnknown(true);

export const releaseGuardReceiptSchema = object({
  schemaVersion: number().required().oneOf([1]),
  installationId: string()
    .required()
    .matches(UUID_RE, 'installationId must be a UUID'),
  generation: positiveSafeInteger('generation'),
  stateDigest: string().required().matches(HEX_DIGEST_RE),
  slot: releaseGuardSlotSchema.required(),
  minimums: object({
    srsLifecycle: number().required().oneOf([1]),
  })
    .required()
    .noUnknown(true),
  artifact: releaseGuardArtifactSchema,
}).noUnknown(true);

export const releaseGuardActiveAdminArtifactSchema = object({
  schemaVersion: number().required().oneOf([1]),
  installationId: string()
    .required()
    .matches(UUID_RE, 'installationId must be a UUID'),
  generation: positiveSafeInteger('generation'),
  slot: object({
    role: string<'admin'>().required().oneOf(['admin']),
    id: string<'default'>().required().oneOf(['default']),
  })
    .required()
    .noUnknown(true),
  artifact: releaseGuardArtifactSchema,
}).noUnknown(true);

export const releaseGuardSlotParamSchema = releaseGuardSlotSchema;
