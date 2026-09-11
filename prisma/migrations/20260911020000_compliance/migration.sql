CREATE TABLE "ConsentRecord" ("id" TEXT PRIMARY KEY, "sequence" BIGSERIAL NOT NULL UNIQUE, "phone" TEXT NOT NULL, "snapshot" JSONB NOT NULL);
CREATE INDEX "ConsentRecord_phone_sequence_idx" ON "ConsentRecord"("phone", "sequence");
CREATE TABLE "DncClearance" ("id" TEXT PRIMARY KEY, "sequence" BIGSERIAL NOT NULL UNIQUE, "phone" TEXT NOT NULL, "snapshot" JSONB NOT NULL);
CREATE INDEX "DncClearance_phone_sequence_idx" ON "DncClearance"("phone", "sequence");
CREATE FUNCTION immutable_compliance_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Compliance evidence is append-only'; END; $$;
CREATE TRIGGER consent_evidence_immutable BEFORE UPDATE OR DELETE ON "ConsentRecord" FOR EACH ROW EXECUTE FUNCTION immutable_compliance_evidence();
CREATE TRIGGER dnc_evidence_immutable BEFORE UPDATE OR DELETE ON "DncClearance" FOR EACH ROW EXECUTE FUNCTION immutable_compliance_evidence();
