-- The brand wallet: the wallet the admin sends xDAI and xBZZ from to the
-- wallets of the brand's nodes, through the manager's funding API
-- (docs/architecture/funding.md).
--
-- The API creates it on its first start with BRAND_WALLET_SECRET set, and
-- keeps its private key here encrypted with AES-256-GCM under that secret,
-- which never reaches the database. The key is decrypted only to sign a
-- transfer, and by `wallet:export`, which prints it for the backup handed to
-- the brand. Every start decrypts it once to check the secret opens it and
-- that it is the key of the stored address.
--
-- One brand, one wallet, one row: `id` can only be true, as in
-- catalogue_stamp (migration 010).
--
--   address         the wallet's address, 0x and 40 hex digits in lower case,
--                   which the brand funds and the Funding page shows. In clear,
--                   so showing it needs no decryption.
--   key_ciphertext  the private key's 32 bytes, encrypted.
--   key_iv          the 12 random bytes this encryption used, drawn for it.
--   key_auth_tag    GCM's 16-byte tag, which a wrong secret or a changed byte
--                   of the other two fails.
--   created_at      when the API created the wallet, by the admin's clock.

CREATE TABLE brand_wallet (
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  address         TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  key_ciphertext  BYTEA NOT NULL CHECK (octet_length(key_ciphertext) = 32),
  key_iv          BYTEA NOT NULL CHECK (octet_length(key_iv) = 12),
  key_auth_tag    BYTEA NOT NULL CHECK (octet_length(key_auth_tag) = 16),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
