-- Runs once, on first initialisation of an empty data directory.
-- Establishes the non-owner identity the application connects as, so that the
-- REVOKE on capacity_ledger_entry in the migration actually binds. A table's
-- owner keeps every privilege regardless of REVOKE, so the application must not
-- be the owner.
CREATE ROLE app_role NOLOGIN;
CREATE ROLE capacity_app LOGIN PASSWORD 'capacity_local_dev' IN ROLE app_role;
GRANT CONNECT ON DATABASE capacity TO app_role;
GRANT USAGE ON SCHEMA public TO app_role;
