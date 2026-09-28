-- The public ingest address of a deployment: the address encoders dial, which
-- the stage record the manager pushes into the web2 admin carries. The address
-- the manager's ssh dials can be a private one, so it is a setting of its own.
--
-- NULL is no setting, and the address is then the host the manager resolved for
-- the deployment, or PUBLIC_HOST for one on the manager's own host. The service
-- holds a value to the stage record's rule, a host name, an IPv4 address or a
-- bracketed IPv6 one; the column refuses an empty or overlong one as a backstop.
--
-- It changes nothing a container reads, so saving it deploys nothing.
--
-- Going back to an older manager needs no step: it never reads the column.
ALTER TABLE profiles ADD COLUMN ingest_host TEXT
  CHECK (ingest_host IS NULL OR (ingest_host <> '' AND length(ingest_host) <= 253));
