-- Migration: Add UNIQUE constraint for artifact is_latest flag
-- Date: 2025-12-29
-- Purpose: Prevent race conditions where multiple revisions of the same artifact
--          are marked as is_latest=true simultaneously.

-- Check for existing violations before creating the index
DO $$
DECLARE
  violation_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO violation_count
  FROM (
    SELECT metadata->>'artifact_id' as artifact_id
    FROM cortex.object
    WHERE metadata->>'is_latest' = 'true'
      AND deleted_at IS NULL
    GROUP BY metadata->>'artifact_id'
    HAVING COUNT(*) > 1
  ) violations;

  IF violation_count > 0 THEN
    RAISE NOTICE 'Found % artifacts with multiple is_latest=true revisions. Fixing...', violation_count;

    -- Fix violations: Keep only the newest revision as is_latest=true
    WITH ranked AS (
      SELECT id,
             metadata->>'artifact_id' as artifact_id,
             ROW_NUMBER() OVER (
               PARTITION BY metadata->>'artifact_id'
               ORDER BY created_at DESC, COALESCE((metadata->>'revision')::int, 0) DESC
             ) as rn
      FROM cortex.object
      WHERE metadata->>'is_latest' = 'true'
        AND deleted_at IS NULL
    )
    UPDATE cortex.object o
    SET metadata = jsonb_set(o.metadata, '{is_latest}', 'false'::jsonb)
    FROM ranked r
    WHERE o.id = r.id AND r.rn > 1;

    RAISE NOTICE 'Fixed violations. Proceeding with index creation.';
  ELSE
    RAISE NOTICE 'No violations found. Proceeding with index creation.';
  END IF;
END $$;

-- Create UNIQUE partial index to enforce atomicity
CREATE UNIQUE INDEX IF NOT EXISTS idx_cortex_object_artifact_latest
ON cortex.object ((metadata->>'artifact_id'))
WHERE metadata->>'is_latest' = 'true' AND deleted_at IS NULL;

-- Add index comment for documentation
COMMENT ON INDEX cortex.idx_cortex_object_artifact_latest IS
'Ensures atomicity: only one revision per artifact can be marked is_latest=true.
Prevents race conditions during artifact updates by enforcing uniqueness at the database level.';

-- Verification query (for manual testing)
-- Uncomment to verify the constraint works:
-- INSERT INTO cortex.object (user_id, metadata)
-- VALUES ('test-user', '{"artifact_id": "test-artifact", "is_latest": true, "revision": 1}'::jsonb);
-- INSERT INTO cortex.object (user_id, metadata)
-- VALUES ('test-user', '{"artifact_id": "test-artifact", "is_latest": true, "revision": 2}'::jsonb);
-- Expected: Second INSERT should fail with unique constraint violation
