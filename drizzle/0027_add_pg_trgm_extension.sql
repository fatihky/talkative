-- trigram operator classes for the substring (ILIKE) search indexes; a trusted extension since pg 13, so the database owner can create it
CREATE EXTENSION IF NOT EXISTS pg_trgm;
