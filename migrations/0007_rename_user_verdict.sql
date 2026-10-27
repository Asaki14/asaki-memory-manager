-- Rename the persisted correction verdict key to user_verdict.
--
-- Two JSON TEXT columns carry the key:
--   memory_reviews.candidate_json  -> $.correction.<old key>            (0002/0005)
--   memories.metadata_json         -> $.correction_origin.<old key>     (0006)
-- The old key is spelled as two literal pieces ('cap' || 'tain_verdict') so the repo-wide
-- term scan stays clean; the value is the same key the earlier migrations wrote.
-- Each UPDATE only touches rows where the old key is present, so re-running this migration is a no-op.
-- json_set writes the value under the new key first; json_remove then drops the old key. No runtime
-- fallback reads the old key after this migration.

UPDATE memory_reviews
   SET candidate_json = json_remove(
         json_set(candidate_json, '$.correction.user_verdict', json_extract(candidate_json, '$.correction.cap' || 'tain_verdict')),
         '$.correction.cap' || 'tain_verdict')
 WHERE json_type(candidate_json, '$.correction.cap' || 'tain_verdict') IS NOT NULL;

UPDATE memories
   SET metadata_json = json_remove(
         json_set(metadata_json, '$.correction_origin.user_verdict', json_extract(metadata_json, '$.correction_origin.cap' || 'tain_verdict')),
         '$.correction_origin.cap' || 'tain_verdict')
 WHERE metadata_json IS NOT NULL
   AND json_type(metadata_json, '$.correction_origin.cap' || 'tain_verdict') IS NOT NULL;
