-- What an API key may do (ADR 0033). Until now a key could do whatever the API offered, which was
-- one thing: send events. The same key is meant to sit in an SDK, where it can be read by whoever
-- has the application; it must not also be the key that reads what the platform found in a
-- customer's code or asks for an analysis of it.
--
-- Existing keys keep what they could do: send events. The scopes are fixed when a key is issued
-- and the application role cannot change them (it can update only revoked_at, as before), so a key
-- that needs more is revoked and replaced, and the audit log shows both.
ALTER TABLE api_keys
  ADD COLUMN scopes text[] NOT NULL DEFAULT ARRAY['events:write']::text[]
    CHECK (
      array_ndims(scopes) = 1
      AND cardinality(scopes) >= 1
      AND scopes <@ ARRAY['events:write', 'analysis:read', 'analysis:write']::text[]
    );
