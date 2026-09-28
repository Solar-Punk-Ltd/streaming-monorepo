import { UUID_PATTERN } from '@streaming-monorepo/contracts';
import { object, string } from 'yup';

/**
 * The `:stageId` of the manager's stage routes: a UUID, in either case. The route lower-cases it before comparing it
 * with the record's own `stageId`, which the contract keeps in lower case.
 */
export const stageIdParamSchema = object({
  stageId: string().required().matches(UUID_PATTERN, 'stageId must be a UUID'),
}).strict();
