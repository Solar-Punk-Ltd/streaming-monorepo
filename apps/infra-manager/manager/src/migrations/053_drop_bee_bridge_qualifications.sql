-- Drops bee_bridge_qualifications, which migration 040 created. The table
-- belonged to a Docker transport for chequebook transfers that the manager no
-- longer has, and nothing reads or writes it. Its rows are deleted with it.
-- The partial unique index bee_bridge_qualifications_one_pass and the sequence
-- behind its id column belonged to it alone and go with the table.
DROP TABLE IF EXISTS bee_bridge_qualifications;
