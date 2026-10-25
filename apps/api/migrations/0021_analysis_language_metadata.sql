-- Additive envelope version; all receipt/auth/generation/deadline triggers stay intact.
ALTER TABLE media_analyses DROP CONSTRAINT media_analyses_document_check;
ALTER TABLE media_analyses ADD CONSTRAINT media_analyses_document_check
  CHECK(document->>'schemaVersion' IN ('1.0.0','1.1.0','1.2.0'));
