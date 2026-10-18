-- migrate:up
-- Face ID on the ops website: a manager's passkey belongs to the site (relying party) it was made on.
-- Mini-app passkeys (patient.hackharvard2026.velroi.com) keep rp_id null; the website's use the
-- parent domain (hackharvard2026.velroi.com), or localhost in development.
set local role app_owner;
alter table ops.passkeys add column rp_id text;
comment on column ops.passkeys.rp_id is 'The WebAuthn relying party the passkey was registered for; null for the Trial Ops mini-apps.';

-- migrate:down
set local role app_owner;
alter table ops.passkeys drop column rp_id;
