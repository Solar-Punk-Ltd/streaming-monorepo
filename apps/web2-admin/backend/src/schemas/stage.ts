import { UUID_PATTERN } from '@streaming-monorepo/contracts';
import { type InferType, object, string } from 'yup';

/**
 * What `POST /api/catalogue-stamp/move` takes: the batch the page named, 64 hex digits, which the service compares
 * with the designated one. Lower-cased here, as the record keeps it.
 */
export const catalogueMoveBodySchema = object({
  targetBatchId: string()
    .required('targetBatchId is required')
    .matches(/^[0-9a-fA-F]{64}$/, 'targetBatchId must be a batch id, 64 hex digits')
    .lowercase(),
});

export type CatalogueMoveBody = InferType<typeof catalogueMoveBodySchema>;

/**
 * The `:stageId` of the manager's stage routes: a UUID, in either case. The route lower-cases it before comparing it
 * with the record's own `stageId`, which the contract keeps in lower case.
 */
export const stageIdParamSchema = object({
  stageId: string().required().matches(UUID_PATTERN, 'stageId must be a UUID'),
}).strict();
